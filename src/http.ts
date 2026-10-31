import { createServer, type Server as HttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLogger } from './utils/logger';

const log = createLogger('mcp-inbox:http');

export interface HttpConfig {
  port: number;
  host: string;
  token: string;
}

function tokenOk(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer /i, '') ?? '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Stateless streamable HTTP on POST /mcp. No sessions: every request gets
 * its own Server + transport, so any number of clients can connect and
 * there is no per-client state to leak. The tools never push server-initiated
 * messages, so GET (SSE stream) is answered with 405.
 */
export function startHttpServer(cfg: HttpConfig, makeServer: () => Server): Promise<HttpServer> {
  const http = createServer((req, res) => {
    const reply = (status: number, msg: string): void => {
      res.writeHead(status, { 'content-type': 'text/plain' }).end(msg);
    };
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/mcp') return reply(404, 'Not found');
    if (!tokenOk(req.headers.authorization, cfg.token)) return reply(401, 'Unauthorized');
    if (req.method !== 'POST') return reply(405, 'Method not allowed');

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // 25 MB: room for base64 attachments on send, bounded against abuse.
      if (size > 25 * 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      void (async () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return reply(400, 'Invalid JSON');
        }
        const server = makeServer();
        const transport = new StreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        } catch (err) {
          log.error('http request failed', {
            msg: err instanceof Error ? err.message : String(err),
          });
          if (!res.headersSent) reply(500, 'Internal error');
        }
      })();
    });
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(cfg.port, cfg.host, () => {
      log.info('listening', { host: cfg.host, port: cfg.port, path: '/mcp' });
      resolve(http);
    });
  });
}

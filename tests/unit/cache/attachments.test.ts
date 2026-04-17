import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachmentPath,
  hashBytes,
  writeAttachment,
  readAttachment,
  deleteAttachmentFile,
} from '../../../src/cache/attachments';

describe('attachment file store', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'mcp-inbox-test-'));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  describe('hashBytes', () => {
    it('matches a known SHA-256 vector', () => {
      // echo -n "hello" | sha256sum
      expect(hashBytes(Buffer.from('hello'))).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
    });

    it('produces 64 hex chars for any input', () => {
      expect(hashBytes(Buffer.from(''))).toMatch(/^[0-9a-f]{64}$/);
      expect(hashBytes(Buffer.from('a'))).toMatch(/^[0-9a-f]{64}$/);
      expect(hashBytes(Buffer.alloc(1024, 0xff))).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('attachmentPath', () => {
    it('uses a two-char prefix directory', () => {
      const path = attachmentPath(
        '/cache',
        'abc123def4567890000000000000000000000000000000000000000000000000',
      );
      // Accept either forward- or back-slash separators (Windows vs POSIX).
      expect(path).toMatch(
        /^[/\\]cache[/\\]attachments[/\\]ab[/\\]c123def4567890000000000000000000000000000000000000000000000000$/,
      );
    });

    it('rejects non-64-char inputs', () => {
      expect(() => attachmentPath('/cache', 'tooshort')).toThrow(/Invalid sha256/);
    });
  });

  describe('writeAttachment / readAttachment', () => {
    it('round-trips bytes through disk', () => {
      const bytes = Buffer.from('hello world');
      const { sha256, filePath, sizeBytes } = writeAttachment(cacheDir, bytes);

      expect(sha256).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
      expect(sizeBytes).toBe(11);
      expect(existsSync(filePath)).toBe(true);
      expect(readAttachment(filePath).equals(bytes)).toBe(true);
    });

    it('writing identical bytes twice is a no-op (idempotent)', () => {
      const bytes = Buffer.from('idempotent');
      const a = writeAttachment(cacheDir, bytes);
      const b = writeAttachment(cacheDir, bytes);

      expect(a.filePath).toBe(b.filePath);
      expect(a.sha256).toBe(b.sha256);
    });

    it('different bytes produce different paths', () => {
      const a = writeAttachment(cacheDir, Buffer.from('one'));
      const b = writeAttachment(cacheDir, Buffer.from('two'));

      expect(a.sha256).not.toBe(b.sha256);
      expect(a.filePath).not.toBe(b.filePath);
    });

    it('readAttachment throws a CacheError for a missing file', () => {
      expect(() => readAttachment('/nonexistent/path')).toThrow(/Attachment not found/);
    });
  });

  describe('deleteAttachmentFile', () => {
    it('removes an existing file', () => {
      const { filePath } = writeAttachment(cacheDir, Buffer.from('delete me'));
      expect(existsSync(filePath)).toBe(true);
      deleteAttachmentFile(filePath);
      expect(existsSync(filePath)).toBe(false);
    });

    it('is a silent no-op for a missing file', () => {
      expect(() => deleteAttachmentFile('/nonexistent/path')).not.toThrow();
    });

    it('does not throw when called twice on the same path', () => {
      const filePath = join(cacheDir, 'tmp-file');
      writeFileSync(filePath, 'x');
      deleteAttachmentFile(filePath);
      expect(() => deleteAttachmentFile(filePath)).not.toThrow();
    });
  });
});

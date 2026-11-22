---
'@kbzowski/mcp-inbox': patch
---

Dependency updates. nodemailer 10.6.1 fixes recipient-domain handling that could differ from what was validated (10.4.1 security release), and the MCP SDK's HTTP transport now resolves to patched hono / @hono/node-server. drizzle-orm moves from 1.0.0-beta.22 to 1.0.0-rc.6; existing cache databases are migrated as before, with no rebuild.

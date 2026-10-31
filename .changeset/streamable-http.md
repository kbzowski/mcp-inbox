---
'@kbzowski/mcp-inbox': minor
---

Optional streamable HTTP transport. Set `MCP_HTTP_PORT` and `MCP_AUTH_TOKEN` to serve POST `/mcp` (stateless, bearer-token protected) so several clients can share one server; stdio stays the default. `compose.yaml` now runs it as a long-lived service.

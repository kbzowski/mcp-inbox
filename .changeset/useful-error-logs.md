---
'@kbzowski/mcp-inbox': patch
---

Error logs now say what went wrong. Background failures (IDLE, index sweeper, shutdown) used to log no reason at all; every log entry now carries the full error with its cause chain, stack and server response. Failed tool calls also log the folder, UID and duration, and partial failures after a send (Sent copy, draft delete, `\Answered` flag) are logged instead of only being returned to the client. Email addresses in logged errors are masked, and embeddings error response bodies are no longer kept, so only the HTTP status is logged.

Fixed: `imap_delete_email`, `imap_delete_multiple` with `hard_delete`, `imap_update_draft` and `imap_send_draft` reported success when the server refused the delete, and dropped the message from the cache while it stayed on the server.

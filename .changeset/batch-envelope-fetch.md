---
'@kbzowski/mcp-inbox': patch
---

Fixed folder sync failing with "Too long argument" on large folders: envelopes are now fetched in batches of 500 UIDs.

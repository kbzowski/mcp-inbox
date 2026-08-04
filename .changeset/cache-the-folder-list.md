---
'@kbzowski/mcp-inbox': patch
---

Stop issuing a LIST on every send, draft and delete.

Resolving `\Drafts`, `\Sent` or `\Trash` ran a full mailbox LIST each time, and
eight code paths do that - every send appends to Sent, every draft tool
resolves Drafts, every delete resolves Trash. Measured against a local
GreenMail with four folders it cost about 90ms a call, roughly a fifth of a
send; a real account with hundreds of labels over the network pays far more,
for an answer that had not changed.

`ImapClient` now caches the list for 60 seconds, which brings twenty
resolutions from 1.8s to nothing measurable. A folder created elsewhere shows
up within the window, and `imap_list_folders` bypasses the cache entirely, so
asking what folders exist still reads the server.

`imap_search_emails` also stopped querying the cache one UID at a time. At the
default limit it ran up to a hundred single-row selects, then a hundred
single-row inserts, then a hundred more selects; it now uses batched queries
throughout - about 9.5ms down to 0.5ms of local work per search.

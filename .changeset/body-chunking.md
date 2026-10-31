---
'@kbzowski/mcp-inbox': minor
---

Semantic search now reads the message text, not just the subject line.

`imap_index_folder` embeds each message's body alongside its subject and sender, splitting long messages into overlapping chunks and ranking a message by its single best-matching passage. A mail titled "Re: 4417" is now findable by what it actually says. Quoted reply history is stripped first, so every message in a thread no longer embeds to nearly the same vector.

Only the text part of each message is fetched, never attachments, which on a real mailbox is around 80x less data than pulling the full messages.

**This release resets the semantic index.** The stored format changed, so the first `imap_index_folder` call after upgrading drops what is there and re-embeds the folder. Nothing else in the cache is affected, and folders you never indexed are untouched.

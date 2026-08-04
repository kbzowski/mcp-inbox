---
'@kbzowski/mcp-inbox': minor
---

Semantic search now spans folders and keeps itself up to date.

`imap_semantic_search` takes an optional `folder`. Leave it out and every indexed folder is searched at once, with each result saying which folder it came from - "find that mail anywhere" instead of having to guess where it lives.

`imap_index_folder` takes a list of folders that share one `max_messages` budget, so a whole mailbox can be indexed a few hundred messages at a time.

New mail no longer waits for you to search the right folder. A background pass tops up every indexed folder on an interval (`IMAP_EMBEDDINGS_SWEEP_MINUTES`, 15 by default, `0` disables). Searching stopped indexing as a side effect, so its latency is predictable now.

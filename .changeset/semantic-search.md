---
'@kbzowski/mcp-inbox': minor
---

Add optional semantic search over your mail.

Two new tools: `imap_index_folder` builds a local vector index for a folder, and `imap_semantic_search` finds messages by meaning rather than by keyword, so "the invoice from the hosting provider" matches a message titled "Payment receipt #4417".

The feature is off unless you set `IMAP_EMBEDDINGS_BASE_URL`, and indexing is opt-in per folder, because it sends message subjects and senders to that endpoint. Any OpenAI-compatible `/v1/embeddings` API works, including one running locally. Vectors are stored in the existing SQLite cache via sqlite-vec and survive restarts; they also outlive the message bodies that body retention prunes.

sqlite-vec ships no binary for windows-arm64 or Alpine/musl. There the two new tools return an error pointing at `imap_search_emails` and everything else works as before.

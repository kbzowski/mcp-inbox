---
'@kbzowski/mcp-inbox': minor
---

`imap_forward` no longer drops attachments.

Forwarding rebuilt the message from the cached plain-text and HTML bodies, so
anything else in the original was discarded. Forwarding an invoice delivered
the covering note without the PDF, and neither the response text nor
`structuredContent` said so.

The original is now attached verbatim as a `message/rfc822` part named after
its subject, the way desktop mail clients forward. Attachments, inline images,
S/MIME signatures and DKIM all survive, because nothing is re-encoded. The
inline quoted body stays as it was, and `structuredContent` reports
`original_attached`.

The bytes travel server to server and never pass through the model's context,
so a large forward costs nothing in tokens.

One behaviour change: a forward of an already-cached message now issues one
body fetch where it previously issued none. Reading the original in full is
what makes the passthrough possible.

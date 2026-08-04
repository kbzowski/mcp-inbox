---
'@kbzowski/mcp-inbox': minor
---

You can now attach files to outgoing mail.

`imap_send_email`, `imap_reply`, `imap_forward`, `imap_create_draft` and
`imap_update_draft` take an optional `attachments` array of
`{ filename, content_base64, content_type? }`. Leave `content_type` off and the
type is derived from the filename. On a forward, these are added alongside the
attached original rather than replacing it.

Attachments are base64 only, never a local path. Reading arbitrary files off
disk is not something this server does, and it would be a worse idea on the way
out than on the way in.

Bear in mind the bytes travel through the model context, so a 2 MB PDF is
roughly 2.7M characters. There is no size cap, because the real ceiling is the
context window and a made-up number would only obscure it. To relay a file the
model did not create, `imap_forward` is far cheaper.

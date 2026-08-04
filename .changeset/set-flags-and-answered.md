---
'@kbzowski/mcp-inbox': minor
---

Stars and follow-up flags are now writable, and replies mark the thread answered.

`\Flagged` was readable all along - the cache stored it and the markdown
formatter rendered it as a star - but nothing could set it. New
`imap_set_flags(folder, uids, add?, remove?)` sets or clears `\Flagged` and
`\Answered` on up to 500 UIDs in one round-trip, and `imap_search_emails`
gained matching `flagged` / `answered` criteria so a starred message can be
found again. Unlike `unseen`, these are three-state: `false` means "match the
negation", not "no filter".

The whitelist is those two flags only. `\Seen` has `imap_mark_read` and
deletion has `imap_delete_email`; routing either through a tool annotated as
idempotent and non-destructive would have been a quiet way to lose mail.

`imap_reply` now sets `\Answered` on the message it replies to, so a thread the
model answered no longer reads as unanswered in Thunderbird or Apple Mail. Pass
`mark_answered: false` to opt out. Like the Sent-folder copy, this never fails
the send - a flag that does not stick is reported in `mark_answered_error`,
because an error here would invite a duplicate reply.

Two smaller consequences: flag writes now share one code path, and that path
checks whether the server actually applied the change. If it reports none - the
UID is gone, or the mailbox opened read-only - the cache is left alone instead
of claiming a flag the server does not hold.

Also fixes `imap_search_emails` rejecting `{ unseen: false }`. The
at-least-one-criterion check was a `??` chain, which read `false` as "nothing
provided".

---
'@kbzowski/mcp-inbox': patch
---

Replies keep the whole conversation thread together.

`imap_reply` emitted a References header containing only the parent's
Message-ID, because the IMAP envelope carries In-Reply-To but not References
and nothing ever read the raw header. Mail clients thread on that chain, so
every reply the server sent started a fresh branch in the recipient's inbox
from the third message onward.

The header is now read with one targeted fetch and the parent's Message-ID
appended to it, capped at 20 entries - keeping the thread root, which is what
clients actually thread on, and trimming the middle. If the fetch fails the
reply still goes out with the old single-entry chain: worse threading is a far
smaller loss than a reply that never left.

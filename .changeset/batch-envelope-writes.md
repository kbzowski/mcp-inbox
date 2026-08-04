---
'@kbzowski/mcp-inbox': patch
---

Cold sync of a large folder writes envelopes in batches.

`fetchEnvelopes` inserted one envelope per statement, and outside a transaction
each of those commits on its own. Seeding a 40k-message folder took 7.8s of
local database work; batching the writes brings it to 4.4s on the same machine.
The remaining time is query-building overhead, not SQLite, and on a folder that
size the IMAP fetch itself dwarfs both.

The batch size is a constant rather than the whole folder because the
transaction is synchronous and cannot span the `await` on the fetch iterator.

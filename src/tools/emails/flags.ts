import type { ToolContext } from '../define-tool';
import { mapImapError } from '../../errors/mapper';
import { mutateEmailFlagsForUids } from '../../cache/queries';

export interface FlagChange {
  add?: string[];
  remove?: string[];
}

/**
 * Add and/or remove IMAP flags on a set of UIDs, then write through to the
 * cache. Returns false when the server accepted the command but reported no
 * change (UID gone, mailbox opened read-only) - the cache is left alone in
 * that case so it never claims a flag the server does not hold.
 *
 * Callers must not hold a mailbox lock: ImapFlow serialises locks per
 * connection and this takes its own, so nesting deadlocks.
 */
export async function applyFlags(
  ctx: ToolContext,
  folder: string,
  uids: number[],
  change: FlagChange,
): Promise<boolean> {
  const add = change.add ?? [];
  const remove = change.remove ?? [];

  const imap = await ctx.imap.connection();
  const lock = await imap.getMailboxLock(folder);
  let ok = true;
  try {
    if (add.length > 0) {
      ok = await imap.messageFlagsAdd(uids, add, { uid: true });
    }
    if (remove.length > 0) {
      ok = (await imap.messageFlagsRemove(uids, remove, { uid: true })) && ok;
    }
  } catch (err) {
    throw mapImapError(err);
  } finally {
    lock.release();
  }

  if (!ok) return false;

  const addSet = new Set(add);
  const removeSet = new Set(remove);
  mutateEmailFlagsForUids(ctx.db, folder, uids, (flags) => [
    ...new Set([...flags.filter((f) => !removeSet.has(f)), ...addSet]),
  ]);

  return true;
}

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CacheError } from '../errors/types.js';

/**
 * Content-addressed attachment store.
 *
 * On-disk layout:
 *   <cacheDir>/attachments/<first2>/<rest>
 *
 * The two-character prefix directory keeps any single filesystem directory
 * from growing unbounded; git uses the same trick for object storage.
 *
 * Keys are lowercase hex SHA-256 of the attachment bytes. Two messages
 * forwarding the same PDF store the bytes once; the `attachments` DB table
 * tracks metadata and `email_attachments` records which message references
 * which hash.
 */

export interface AttachmentWriteResult {
  sha256: string;
  filePath: string;
  sizeBytes: number;
}

/** Absolute path where an attachment with this hash would live. */
export function attachmentPath(cacheDir: string, sha256: string): string {
  if (sha256.length !== 64) {
    throw new CacheError(
      'CACHE_IO_FAILED',
      `Invalid sha256: expected 64 hex chars, got ${sha256.length}`,
    );
  }
  return join(cacheDir, 'attachments', sha256.slice(0, 2), sha256.slice(2));
}

export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Write an attachment to the content-addressed store. Idempotent: if the
 * exact same bytes have been written before, the existing file is left
 * untouched (matching hash → matching content, by definition of SHA-256).
 */
export function writeAttachment(cacheDir: string, bytes: Buffer): AttachmentWriteResult {
  const sha256 = hashBytes(bytes);
  const filePath = attachmentPath(cacheDir, sha256);

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
      writeFileSync(filePath, bytes);
    }
  } catch (err) {
    throw new CacheError(
      'CACHE_IO_FAILED',
      `Failed to write attachment to ${filePath}. Check cache directory permissions and disk space.`,
      err,
    );
  }

  return { sha256, filePath, sizeBytes: bytes.length };
}

export function readAttachment(filePath: string): Buffer {
  try {
    return readFileSync(filePath);
  } catch (err) {
    throw new CacheError(
      'ATTACHMENT_NOT_FOUND',
      `Attachment not found on disk: ${filePath}. The file may have been evicted from the LRU cache; re-fetch from IMAP.`,
      err,
    );
  }
}

/**
 * Remove an attachment file from disk. Safe to call for a missing file —
 * the caller may be racing against LRU eviction elsewhere.
 */
export function deleteAttachmentFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Already gone or never existed — both acceptable.
  }
}

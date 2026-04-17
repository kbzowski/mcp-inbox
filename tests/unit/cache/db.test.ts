import { describe, it, expect } from 'vitest';
import { diagnoseOpenError } from '@/cache/db';

describe('diagnoseOpenError', () => {
  const path = '/tmp/cache.db';

  it('detects EBUSY / database-locked as a competing instance', () => {
    const err = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const msg = diagnoseOpenError(path, err);
    expect(msg).toMatch(/locked/i);
    expect(msg).toMatch(/another mcp-inbox instance/i);
  });

  it('detects EACCES as a permission error (the one case the old code got right)', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const msg = diagnoseOpenError(path, err);
    expect(msg).toContain('Permission denied');
    expect(msg).toContain('IMAP_CACHE_DIR is writable');
  });

  it('detects EPERM (Windows mkdir failure path) as a permission error', () => {
    const err = Object.assign(new Error("EPERM: operation not permitted, mkdir 'C:\\root\\x'"), {
      code: 'EPERM',
    });
    const msg = diagnoseOpenError(path, err);
    expect(msg).toContain('Permission denied');
  });

  it('detects ENOENT as a path-not-found issue', () => {
    const err = Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
    const msg = diagnoseOpenError(path, err);
    expect(msg).toMatch(/path not found/i);
  });

  it('surfaces the raw error message when no known pattern matches', () => {
    const err = new Error('something exotic happened');
    const msg = diagnoseOpenError(path, err);
    expect(msg).toContain('Underlying error: something exotic happened');
  });

  it('includes the database path in every message', () => {
    const err = new Error('x');
    expect(diagnoseOpenError(path, err)).toContain(path);
  });
});

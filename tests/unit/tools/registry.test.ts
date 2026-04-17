import { describe, it, expect } from 'vitest';
import { findTool, listToolEntries, tools } from '../../../src/tools/registry.js';

describe('tool registry', () => {
  it('exposes the expected tool set', () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'imap_create_draft',
      'imap_delete_email',
      'imap_forward',
      'imap_get_draft',
      'imap_get_email',
      'imap_list_drafts',
      'imap_list_emails',
      'imap_list_folders',
      'imap_mark_read',
      'imap_mark_unread',
      'imap_move_to_folder',
      'imap_reply',
      'imap_search_emails',
      'imap_send_draft',
      'imap_send_email',
      'imap_update_draft',
    ]);
  });

  it('findTool returns the matching definition', () => {
    expect(findTool('imap_list_folders')?.name).toBe('imap_list_folders');
    expect(findTool('nope')).toBeUndefined();
  });

  it('tool names are prefixed with imap_ (collision-safe convention)', () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^imap_/);
    }
  });

  it('every tool carries the four required annotations', () => {
    for (const t of tools) {
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
      expect(typeof t.annotations.destructiveHint).toBe('boolean');
      expect(typeof t.annotations.idempotentHint).toBe('boolean');
      expect(t.annotations.openWorldHint).toBe(true);
    }
  });

  it('listToolEntries produces JSON-Schema input schemas', () => {
    const entries = listToolEntries();
    for (const entry of entries) {
      expect(entry.inputSchema).toEqual(
        expect.objectContaining({
          type: 'object',
        }),
      );
    }
  });

  it('input schemas carry property descriptions through to JSON Schema', () => {
    const listEmails = listToolEntries().find((e) => e.name === 'imap_list_emails');
    const props = (
      listEmails?.inputSchema as { properties?: Record<string, { description?: string }> }
    ).properties;
    expect(props?.max_staleness_seconds?.description).toMatch(/cache/i);
  });
});

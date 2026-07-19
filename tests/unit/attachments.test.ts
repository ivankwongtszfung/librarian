import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  resolveAttachment,
  saveDataUrl,
} from '../../src/infrastructure/service/attachments.js';

// Screenshots pasted into the chat bar are stored on disk and the agent is
// handed the path — so the gates that matter are: only images, size-capped,
// and no crafted filename may escape the directory.

const dir = () => mkdtempSync(join(tmpdir(), 'librarian-att-'));

// 1x1 transparent PNG
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('saveDataUrl', () => {
  it('stores a png and returns a path that actually holds the bytes', () => {
    const d = dir();
    const saved = saveDataUrl(d, PNG);
    expect(saved.file).toMatch(/^att_[a-f0-9]+\.png$/);
    expect(saved.mime).toBe('image/png');
    expect(saved.bytes).toBeGreaterThan(0);
    expect(readFileSync(saved.path).byteLength).toBe(saved.bytes);
  });

  it('refuses anything that is not an image data URL', () => {
    const d = dir();
    expect(() => saveDataUrl(d, 'https://example.com/x.png')).toThrow(AttachmentError);
    expect(() => saveDataUrl(d, '')).toThrow(AttachmentError);
    // a script masquerading as an attachment
    expect(() => saveDataUrl(d, 'data:text/html;base64,PHNjcmlwdD4=')).toThrow(AttachmentError);
    expect(() => saveDataUrl(d, 'data:image/svg+xml;base64,PHN2Zz4=')).toThrow(AttachmentError);
  });

  it('enforces the size cap', () => {
    const d = dir();
    const huge = `data:image/png;base64,${'A'.repeat(Math.ceil((MAX_ATTACHMENT_BYTES + 1024) / 3) * 4)}`;
    expect(() => saveDataUrl(d, huge)).toThrow(AttachmentError);
  });
});

describe('resolveAttachment', () => {
  it('resolves a generated filename', () => {
    const d = dir();
    const saved = saveDataUrl(d, PNG);
    const found = resolveAttachment(d, saved.file);
    expect(found?.path).toBe(saved.path);
    expect(found?.mime).toBe('image/png');
  });

  it('refuses traversal and anything off-shape', () => {
    const d = dir();
    for (const bad of [
      '../../../etc/passwd',
      'att_abc.png/../../secret',
      '/etc/passwd',
      'att_abc.exe',
      'notanattachment.png',
      'att_ABC.png', // generated ids are lowercase hex
      '',
    ]) {
      expect(resolveAttachment(d, bad)).toBeNull();
    }
  });
});

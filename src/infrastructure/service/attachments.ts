import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { newId } from '../../util/ids.js';

/**
 * Screenshots pasted into the review UI chat bar.
 *
 * The channel protocol carries TEXT only (`content` is a string, `meta` is
 * string→string), so an image can never ride the wire. Instead it is written to
 * disk beside the store and the agent is handed the **path** — it reads the file
 * with its own Read tool. This mirrors the official plugins, where attachments
 * are not auto-delivered either: the assistant asks for them explicitly.
 */

/** Only real image types, and only ones a browser will render back. */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** A stored filename is always `att_<hex>.<ext>` — anything else is refused, so
 *  a crafted name can never walk out of the attachments directory. */
const FILE_RE = /^att_[a-f0-9]+\.(png|jpg|gif|webp)$/;

export interface SavedAttachment {
  /** Filename, also the URL segment: `att_ab12.png`. */
  file: string;
  /** Absolute path on disk — what the agent is told to Read. */
  path: string;
  mime: string;
  bytes: number;
}

export class AttachmentError extends Error {
  constructor(readonly code: 'not_an_image' | 'unsupported_type' | 'too_large') {
    super(code);
  }
}

/** Decode a `data:image/...;base64,...` URL and store it. */
export function saveDataUrl(dir: string, dataUrl: string): SavedAttachment {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(
    String(dataUrl ?? '').trim(),
  );
  if (!match) throw new AttachmentError('not_an_image');
  const mime = match[1].toLowerCase();
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new AttachmentError('unsupported_type');

  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.byteLength) throw new AttachmentError('not_an_image');
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new AttachmentError('too_large');

  mkdirSync(dir, { recursive: true });
  const file = `${newId('att')}.${ext}`;
  const path = join(dir, file);
  writeFileSync(path, bytes);
  return { file, path, mime, bytes: bytes.byteLength };
}

/**
 * Resolve a request's filename to a path inside `dir`, or null.
 * Two independent gates: the name must match the generated shape, and the
 * resolved path must still sit under the directory.
 */
export function resolveAttachment(
  dir: string,
  file: string,
): { path: string; mime: string } | null {
  if (!FILE_RE.test(file)) return null;
  const base = resolve(dir);
  const path = resolve(join(base, file));
  if (path !== join(base, file) || !path.startsWith(base + sep)) return null;
  const ext = file.slice(file.lastIndexOf('.') + 1);
  return { path, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' };
}

// The rescan (BUG-001, fix option 1): a deliberate, human-triggered walk of a
// repo for decision-shaped markdown the watcher never saw — docs older than
// the daemon, written by hand, or from sessions librarian never watched.
// Same docs/-only convention as the live watcher: the noise filter is the
// feature. Imports are content-hash-deduped upstream, so rescanning is
// always safe.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'scratchpad', 'dist', 'vendor']);
const DOC_DIR = /^docs?$/i;
const MAX_DEPTH = 6;

export interface ScannedDoc {
  filePath: string;
  content: string;
  /** File mtime — the honest date for a backfilled record. */
  modifiedAt: number;
}

/** Every .md/.mdx under any docs/ directory within root, depth-limited. */
export function scanForDocs(root: string): ScannedDoc[] {
  const out: ScannedDoc[] = [];
  walk(root, 0, false, out);
  return out;
}

function walk(dir: string, depth: number, inDocs: boolean, out: ScannedDoc[]): void {
  if (depth > MAX_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(path, depth + 1, inDocs || DOC_DIR.test(entry), out);
    } else if (inDocs && /\.mdx?$/i.test(entry)) {
      try {
        const content = readFileSync(path, 'utf8');
        if (content.trim()) out.push({ filePath: path, content, modifiedAt: stat.mtimeMs });
      } catch {
        // unreadable file — skip, the scan reports what it imported, not errors
      }
    }
  }
}

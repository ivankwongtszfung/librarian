import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportLibrary } from '../../src/application/export.js';
import { openDb } from '../../src/infrastructure/store/db.js';
import { Repository } from '../../src/infrastructure/store/repository.js';

describe('exportLibrary', () => {
  let dir: string;
  let db: ReturnType<typeof openDb>;
  let store: Repository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'librarian-export-'));
    db = openDb(join(dir, 'db.sqlite'));
    store = new Repository(db);
    store.submit({
      project: 'demo',
      title: 'Use SQLite',
      body: '# Use SQLite\n\nOne file, zero ops.',
      kind: 'adr',
      source: 'mcp',
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exports json with the full decision and its body', () => {
    const out = JSON.parse(exportLibrary(store, { format: 'json' }));
    expect(out.count).toBe(1);
    expect(out.decisions[0].title).toBe('Use SQLite');
    expect(out.decisions[0].versions[0].bodyMd).toContain('zero ops');
  });

  it('exports markdown with the title and body', () => {
    const md = exportLibrary(store, { format: 'md' });
    expect(md).toContain('## Use SQLite');
    expect(md).toContain('zero ops');
  });

  it('filters by project', () => {
    store.submit({ project: 'other', title: 'X', body: 'x', kind: 'plan', source: 'mcp' });
    const out = JSON.parse(exportLibrary(store, { project: 'demo' }));
    expect(out.count).toBe(1);
  });
});

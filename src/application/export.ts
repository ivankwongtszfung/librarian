// Exports the decision library — the archive is the user's only copy, so a
// production tool has to be able to hand it back. JSON is the full, re-importable
// backup; markdown is a human-readable digest. Both read through the store port,
// so they work against any DecisionStore implementation.

import type { DecisionStore } from '../domain/ports.js';
import type { DecisionDetail } from '../domain/types.js';

export interface ExportOptions {
  format?: 'json' | 'md';
  project?: string;
}

export interface ExportBundle {
  exportedAt: string;
  count: number;
  decisions: DecisionDetail[];
}

function collect(store: DecisionStore, project?: string): DecisionDetail[] {
  const list = store.listDecisions(project ? { project } : {});
  const out: DecisionDetail[] = [];
  for (const d of list) {
    const detail = store.getDecisionDetail(d.id);
    if (detail) out.push(detail);
  }
  return out;
}

export function exportLibrary(store: DecisionStore, opts: ExportOptions = {}): string {
  const decisions = collect(store, opts.project);
  if (opts.format === 'md') return toMarkdown(decisions);
  const bundle: ExportBundle = {
    exportedAt: new Date().toISOString(),
    count: decisions.length,
    decisions,
  };
  return JSON.stringify(bundle, null, 2);
}

function toMarkdown(decisions: DecisionDetail[]): string {
  const iso = (ms: number) => new Date(ms).toISOString();
  const parts = [
    `# Librarian export\n\n${decisions.length} decision(s) · ${new Date().toISOString()}\n`,
  ];
  for (const d of decisions) {
    const body = d.versions.at(-1)?.bodyMd ?? '';
    parts.push(`\n---\n\n## ${d.title}\n`);
    parts.push(`\`${d.status}\` · ${d.kind} · ${d.projectName} · ${iso(d.createdAt)}\n`);
    if (body) parts.push(`\n${body}\n`);
    if (d.verdicts.length) {
      parts.push('\n### Verdicts\n');
      for (const v of d.verdicts) {
        parts.push(`- **${v.toState}**${v.reason ? ` — ${v.reason}` : ''} _(${iso(v.at)})_\n`);
      }
    }
    if (d.comments.length) {
      parts.push('\n### Comments\n');
      for (const c of d.comments) {
        const quote = c.anchorQuote ? `> ${c.anchorQuote}\n  ` : '';
        parts.push(`- ${quote}${c.body}\n`);
      }
    }
  }
  return parts.join('');
}

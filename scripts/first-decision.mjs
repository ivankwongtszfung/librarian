#!/usr/bin/env node
/**
 * Librarian's first real use case: submit its own deployment decision for
 * review, through its own MCP server, exactly as an agent would.
 *
 *   node scripts/first-decision.mjs [http://127.0.0.1:7801]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] ?? 'http://127.0.0.1:7801';
const here = dirname(fileURLToPath(import.meta.url));
const doc = readFileSync(join(here, '..', 'docs', 'adr', 'ADR-001-deployment.md'), 'utf8');

const client = new Client({ name: 'claude-code', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

const read = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);

// 1. What has already been decided here — and what has been turned down?
const constraints = read(
  await client.callTool({ name: 'get_constraints', arguments: { project: 'librarian' } }),
);
console.log('constraints before designing:', JSON.stringify(constraints, null, 2));

// 2. Submit the deployment decision for a human verdict.
const submitted = read(
  await client.callTool({
    name: 'submit_for_review',
    arguments: {
      project: 'librarian',
      title: 'ADR-001: How Librarian is deployed',
      doc,
      kind: 'adr',
      agent: 'claude-code',
      context_refs: ['src/cli.ts', 'src/daemon.ts', 'package.json'],
    },
  }),
);
console.log('\nsubmitted:', submitted.review_id, '→', `${base}/d/${submitted.review_id}`);

// 3. Poll for the verdict, exactly as an agent would.
const outcome = read(
  await client.callTool({
    name: 'get_review',
    arguments: { review_id: submitted.review_id, wait_seconds: 2 },
  }),
);
console.log('poll result:', outcome.status, outcome.next ?? '');

await client.close();

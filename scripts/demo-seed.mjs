#!/usr/bin/env node
// Seed helper for the onboarding demo recording.
//   node scripts/demo-seed.mjs submit            → prints review_id of a pending plan
//   node scripts/demo-seed.mjs revise <id>       → resubmits v2 of that plan
//   node scripts/demo-seed.mjs history           → one rejected + one approved decision
// Target daemon: LIBRARIAN_URL or http://127.0.0.1:7807
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.LIBRARIAN_URL ?? 'http://127.0.0.1:7807';

async function mcp(name, args) {
  const client = new Client({ name: 'demo-seed', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const res = await client.callTool({ name, arguments: args });
  await client.close();
  return JSON.parse(res.content.find((c) => c.type === 'text').text);
}

async function verdict(id, to, reason) {
  const res = await fetch(`${BASE}/api/decisions/${id}/verdict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to, reason }),
  });
  if (!res.ok) throw new Error(`verdict failed: ${res.status}`);
}

const PLAN_V1 = `# Plan: session storage for checkout

## Goal
Persist checkout sessions across restarts.

## Approach
Add **Redis** as a session store.

## Steps
1. Add Redis to docker-compose.
2. Introduce a \`SessionStore\` interface.
3. Write sessions through on every mutation.

## Risks
- New infrastructure dependency.
- Cache/DB consistency on failover.`;

const PLAN_V2 = `# Plan: session storage for checkout

## Goal
Persist checkout sessions across restarts.

## Approach
Use the existing **SQLite** database — no new infrastructure.

## Steps
1. Add a \`sessions\` table (WAL mode is already on).
2. Introduce a \`SessionStore\` interface.
3. Write sessions through on every mutation.

## Risks
- Single-writer ceiling — acceptable at current load.`;

const cmd = process.argv[2];

if (cmd === 'submit') {
  const out = await mcp('submit_for_review', {
    project: 'checkout_service',
    title: 'Session storage for checkout',
    doc: PLAN_V1,
    kind: 'plan',
  });
  console.log(out.review_id);
} else if (cmd === 'revise') {
  const id = process.argv[3];
  if (!id) throw new Error('usage: demo-seed.mjs revise <review_id>');
  const out = await mcp('submit_for_review', {
    project: 'checkout_service',
    title: 'Session storage for checkout',
    doc: PLAN_V2,
    kind: 'plan',
    parent_review_id: id,
  });
  console.log(out.review_id);
} else if (cmd === 'history') {
  const rejected = await mcp('submit_for_review', {
    project: 'checkout_service',
    title: 'Split backend into microservices',
    doc: '# Split backend into microservices\n\nCarve the monolith into six services with a message bus.',
    kind: 'plan',
  });
  await verdict(
    rejected.review_id,
    'rejected',
    'Overkill for a single-user product — revisit at 10× load.',
  );
  const adr = await mcp('record_decision', {
    project: 'checkout_service',
    title: 'ADR-007: SQLite is the only store',
    doc: '# ADR-007: SQLite is the only store\n\nOne file, WAL mode, zero ops. Every service reads the same truth.',
    kind: 'adr',
  });
  console.log(JSON.stringify({ rejected: rejected.review_id, adr: adr.decision_id }));
} else {
  console.error('usage: demo-seed.mjs submit|revise <id>|history');
  process.exit(1);
}

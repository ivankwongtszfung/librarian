import { strict as assert } from 'node:assert';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import type { LibrarianWorld } from './world.js';

const PLAN_BODY =
  '# Plan\n\nWe will store sessions in Redis.\n\n## Steps\n\n1. Add Redis.\n2. Wire it up.';
const REVISED_BODY =
  '# Plan\n\nWe will store sessions in SQLite.\n\n## Steps\n\n1. Use the existing DB.\n2. Wire it up.';

// ---------- given ----------

Given('the daemon is running with an empty store', async function (this: LibrarianWorld) {
  await this.boot();
});

Given(
  'the watcher is watching a fixture transcript directory',
  async function (this: LibrarianWorld) {
    // Mirror the real layout: ~/.claude/projects/<slug>/<uuid>.jsonl
    this.watchDir = join(this.tmpDir, '.claude', 'projects');
    mkdirSync(join(this.watchDir, '-Users-x-Projects-accounting-app'), { recursive: true });
    await this.shutdown();
    await this.start();
  },
);

Given('a pending decision', async function (this: LibrarianWorld) {
  const result = await this.callTool('submit_for_review', {
    project: 'accounting_app',
    title: 'Session storage',
    doc: PLAN_BODY,
    kind: 'plan',
  });
  this.reviewId = result.review_id as string;
});

Given(
  'a decision in state {string} with version 1',
  async function (this: LibrarianWorld, state: string) {
    const submitted = await this.callTool('submit_for_review', {
      project: 'accounting_app',
      title: 'Session storage',
      doc: PLAN_BODY,
      kind: 'plan',
    });
    this.reviewId = submitted.review_id as string;

    const res = await this.api('POST', `/api/decisions/${this.reviewId}/comments`, {
      comments: [
        { body: 'Why not SQLite? We already have it.', anchor_quote: 'store sessions in Redis' },
      ],
      request_changes: true,
      reason: 'use SQLite instead',
    });
    assert.equal(res.status, 200);

    const detail = await this.api('GET', `/api/decisions/${this.reviewId}`);
    assert.equal(detail.body.status, state);
  },
);

Given('an in-flight get_review', function (this: LibrarianWorld) {
  this.pollStartedAt = Date.now();
  // Kicked off without awaiting: the point is that a verdict lands while the
  // agent is still holding this call open.
  this.inFlight = this.callTool('get_review', { review_id: this.reviewId, wait_seconds: 20 });
});

Given(
  'a decision titled {string} rejected with reason {string}',
  async function (this: LibrarianWorld, title: string, reason: string) {
    const submitted = await this.callTool('submit_for_review', {
      project: 'accounting_app',
      title,
      doc: `# ${title}\n\nA proposal to ${title.toLowerCase()}.`,
      kind: 'plan',
    });
    const res = await this.api('POST', `/api/decisions/${submitted.review_id}/verdict`, {
      to: 'rejected',
      reason,
    });
    assert.equal(res.status, 200);
  },
);

Given(
  'a decision titled {string} approved for {string}',
  async function (this: LibrarianWorld, title: string, project: string) {
    const submitted = await this.callTool('submit_for_review', {
      project,
      title,
      doc: `# ${title}\n\nApproved work.`,
      kind: 'adr',
    });
    const res = await this.api('POST', `/api/decisions/${submitted.review_id}/verdict`, {
      to: 'approved',
    });
    assert.equal(res.status, 200);
  },
);

Given('a decision submitted via MCP with a known body', async function (this: LibrarianWorld) {
  const result = await this.callTool('record_decision', {
    project: 'accounting-app',
    title: 'ADR-001: SQLite as the store',
    doc: '# ADR-001: SQLite as the store\n\nWe will use SQLite.',
    kind: 'adr',
  });
  this.reviewId = result.decision_id as string;
});

// ---------- when ----------

When(
  'an agent calls submit_for_review with a plan for {string}',
  async function (this: LibrarianWorld, project: string) {
    this.lastToolResult = await this.callTool('submit_for_review', {
      project,
      title: 'Session storage',
      doc: PLAN_BODY,
      kind: 'plan',
    });
    this.reviewId = this.lastToolResult.review_id as string;
  },
);

When(
  'an agent calls record_decision for {string}',
  async function (this: LibrarianWorld, project: string) {
    this.lastToolResult = await this.callTool('record_decision', {
      project,
      title: 'ADR-002: Chart simplicity',
      doc: '# ADR-002\n\nCharts stay simple.',
      kind: 'adr',
    });
  },
);

When('the agent resubmits with parent_review_id', async function (this: LibrarianWorld) {
  this.lastToolResult = await this.callTool('submit_for_review', {
    project: 'accounting_app',
    title: 'Session storage',
    doc: REVISED_BODY,
    kind: 'plan',
    parent_review_id: this.reviewId,
  });
  this.reviewId = this.lastToolResult.review_id as string;
});

When(
  'the agent calls get_review with wait_seconds {int}',
  async function (this: LibrarianWorld, wait: number) {
    this.pollStartedAt = Date.now();
    this.lastToolResult = await this.callTool('get_review', {
      review_id: this.reviewId,
      wait_seconds: wait,
    });
  },
);

When(
  'a human posts verdict {string} with reason {string}',
  async function (this: LibrarianWorld, to: string, reason: string) {
    const res = await this.api('POST', `/api/decisions/${this.reviewId}/verdict`, { to, reason });
    assert.equal(res.status, 200);
  },
);

When('the connection drops before the hold expires', async function (this: LibrarianWorld) {
  // The in-flight poll will reject when the transport dies — that IS the
  // dropped connection. Swallow it here; the point of the scenario is that the
  // verdict survives it anyway.
  const dropped = this.inFlight?.catch(() => undefined);
  // Kill the whole client transport mid-poll: the harshest version of a drop.
  await this.client?.close();
  await dropped;
  this.inFlight = undefined;
});

When(
  'a human posts verdict {string} while no poll is connected',
  async function (this: LibrarianWorld, to: string) {
    const res = await this.api('POST', `/api/decisions/${this.reviewId}/verdict`, { to });
    assert.equal(res.status, 200);
    this.lastHttpStatus = res.status;
  },
);

When('the agent reconnects and calls get_review again', async function (this: LibrarianWorld) {
  // Only the agent's connection died — the daemon never went anywhere.
  await this.connectClient();
  this.lastToolResult = await this.callTool('get_review', {
    review_id: this.reviewId,
    wait_seconds: 0,
  });
});

When('the daemon restarts', async function (this: LibrarianWorld) {
  await this.shutdown();
  await this.start();
});

When('the agent calls get_review for the same review_id', async function (this: LibrarianWorld) {
  this.lastToolResult = await this.callTool('get_review', {
    review_id: this.reviewId,
    wait_seconds: 0,
  });
});

When(
  'a client posts verdict {string} with no reason',
  async function (this: LibrarianWorld, to: string) {
    const res = await this.api('POST', `/api/decisions/${this.reviewId}/verdict`, { to });
    this.lastHttpStatus = res.status;
    this.lastHttpBody = res.body;
  },
);

When(
  'a client posts comments with an anchored quote and requests changes',
  async function (this: LibrarianWorld) {
    const res = await this.api('POST', `/api/decisions/${this.reviewId}/comments`, {
      comments: [
        { body: 'Why not SQLite? We already have it.', anchor_quote: 'store sessions in Redis' },
        { body: 'Also: what happens on restart?' },
      ],
      request_changes: true,
      reason: 'use SQLite instead',
    });
    assert.equal(res.status, 200);
  },
);

When(
  'an agent calls search_decisions {string}',
  async function (this: LibrarianWorld, query: string) {
    this.lastToolResult = await this.callTool('search_decisions', { query });
  },
);

When(
  'an agent calls get_constraints for {string}',
  async function (this: LibrarianWorld, project: string) {
    this.lastToolResult = await this.callTool('get_constraints', { project });
  },
);

When(
  'a fixture transcript receives an approved ExitPlanMode entry',
  async function (this: LibrarianWorld) {
    writeTranscript(this, approvedPlanLines());
    await waitForCapture(this);
  },
);

When(
  'a fixture transcript receives a rejected ExitPlanMode entry',
  async function (this: LibrarianWorld) {
    writeTranscript(this, rejectedPlanLines());
    await this.daemon!.watcher!.drain();
    await sleep(300);
  },
);

When('the watcher captures a doc with the same content', async function (this: LibrarianWorld) {
  writeTranscript(this, [docWriteLine('# ADR-001: SQLite as the store\n\nWe will use SQLite.')]);
  await waitForCapture(this);
});

// ---------- then ----------

Then(
  'a decision exists with status {string} and source {string}',
  async function (this: LibrarianWorld, status: string, source: string) {
    const res = await this.api('GET', '/api/decisions');
    const decisions = res.body.decisions as Array<Record<string, unknown>>;
    assert.equal(decisions.length, 1, 'expected exactly one decision');
    assert.equal(decisions[0].status, status);
    assert.equal(decisions[0].source, source);
  },
);

Then('an SSE event {string} is emitted', function (this: LibrarianWorld, type: string) {
  assert.ok(
    this.events.some((e) => e.type === type),
    `expected an event of type ${type}, saw: ${this.events.map((e) => e.type).join(', ') || 'none'}`,
  );
});

Then('a notification is published to the ntfy topic', function (this: LibrarianWorld) {
  assert.equal(this.notifier.sent().length, 1);
  assert.match(this.notifier.sent()[0].title, /Pending review/);
});

Then('no notification is published to the ntfy topic', function (this: LibrarianWorld) {
  assert.equal(this.notifier.sent().length, 0, 'record_decision must not page the human');
});

Then('version 2 exists with parent_version_id of version 1', async function (this: LibrarianWorld) {
  const detail = await this.api('GET', `/api/decisions/${this.reviewId}`);
  const versions = detail.body.versions as Array<Record<string, unknown>>;
  assert.equal(versions.length, 2, 'the revision should live on the same decision');
  assert.equal(versions[1].num, 2);
  assert.equal(versions[1].parentVersionId, versions[0].id);
});

Then(
  'the diff between version 1 and 2 is a non-empty unified diff',
  async function (this: LibrarianWorld) {
    const res = await this.api('GET', `/api/decisions/${this.reviewId}/diff?from=1&to=2`);
    assert.equal(res.status, 200);
    const diff = res.body.diff as string;
    assert.ok(diff.length > 0, 'diff should not be empty');
    assert.match(diff, /-We will store sessions in Redis\./);
    assert.match(diff, /\+We will store sessions in SQLite\./);
  },
);

Then(
  'the call returns after about {int}s with status {string}',
  function (this: LibrarianWorld, seconds: number, status: string) {
    const elapsed = Date.now() - (this.pollStartedAt ?? 0);
    assert.equal(this.lastToolResult?.status, status);
    assert.ok(
      elapsed >= seconds * 1000 - 250,
      `expected the server to hold the request ~${seconds}s, it returned in ${elapsed}ms`,
    );
    assert.ok(elapsed < seconds * 1000 + 3000, `held far too long: ${elapsed}ms`);
  },
);

Then(
  'the in-flight call resolves with the verdict and the reason',
  async function (this: LibrarianWorld) {
    const result = await this.inFlight!;
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'conflicts with ADR-004');
    // It must resolve on the verdict, not by waiting out the full hold.
    const elapsed = Date.now() - (this.pollStartedAt ?? 0);
    assert.ok(elapsed < 15000, `should wake on the verdict, took ${elapsed}ms`);
  },
);

Then(
  "the decision's verdict_events contain pending to rejected",
  async function (this: LibrarianWorld) {
    const detail = await this.api('GET', `/api/decisions/${this.reviewId}`);
    const verdicts = detail.body.verdicts as Array<Record<string, unknown>>;
    assert.ok(
      verdicts.some((v) => v.fromState === 'pending' && v.toState === 'rejected'),
      'the red light must be recorded as an event',
    );
  },
);

Then('the verdict_event is persisted normally', async function (this: LibrarianWorld) {
  // Read straight from the store: no client is connected at this point.
  const verdicts = this.daemon!.repo.listVerdicts(this.reviewId!);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].toState, 'approved');
});

Then('the call returns immediately with the stored verdict', function (this: LibrarianWorld) {
  assert.equal(this.lastToolResult?.status, 'approved');
});

Then('repeated get_review calls return the same result', async function (this: LibrarianWorld) {
  const first = await this.callTool('get_review', { review_id: this.reviewId, wait_seconds: 0 });
  const second = await this.callTool('get_review', { review_id: this.reviewId, wait_seconds: 0 });
  assert.equal(first.status, 'approved');
  assert.deepEqual(first, second, 'the poll must be an idempotent read');
});

Then('the call succeeds against the recovered store', function (this: LibrarianWorld) {
  assert.ok(this.lastToolResult, 'expected a result after restart');
  assert.equal(this.lastToolResult?.status, 'pending');
});

Then(
  'the decision is still listed as {string} in the library',
  async function (this: LibrarianWorld, status: string) {
    const res = await this.api('GET', '/api/decisions');
    const decisions = res.body.decisions as Array<Record<string, unknown>>;
    assert.equal(decisions[0].status, status);
  },
);

Then('the API responds {int}', function (this: LibrarianWorld, status: number) {
  assert.equal(this.lastHttpStatus, status);
});

Then('no verdict_event is written', function (this: LibrarianWorld) {
  assert.equal(this.daemon!.repo.listVerdicts(this.reviewId!).length, 0);
});

Then(
  "the agent's get_review resolves with the comments and their anchors",
  async function (this: LibrarianWorld) {
    const result = await this.callTool('get_review', { review_id: this.reviewId, wait_seconds: 0 });
    const comments = result.comments as Array<Record<string, unknown>>;
    assert.equal(comments.length, 2);
    assert.equal(comments[0].anchorQuote, 'store sessions in Redis');
    assert.match(comments[0].body as string, /Why not SQLite/);
  },
);

Then('the decision status is {string}', async function (this: LibrarianWorld, status: string) {
  const detail = await this.api('GET', `/api/decisions/${this.reviewId}`);
  assert.equal(detail.body.status, status);
});

Then(
  'the hit includes status {string} and the reason verbatim',
  function (this: LibrarianWorld, status: string) {
    const hits = this.lastToolResult?.hits as Array<Record<string, unknown>>;
    assert.ok(hits.length > 0, 'search found nothing');
    assert.equal(hits[0].status, status);
    assert.equal(hits[0].reason, 'overkill for single user');
  },
);

Then(
  'the digest lists accepted and rejected decisions with reasons',
  function (this: LibrarianWorld) {
    const accepted = this.lastToolResult?.accepted as Array<Record<string, unknown>>;
    const rejected = this.lastToolResult?.rejected as Array<Record<string, unknown>>;
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].title, 'Pre-production security gate');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].title, 'Split backend into microservices');
    assert.equal(rejected[0].reason, 'overkill for single user');
  },
);

Then(
  'within 2s a decision exists with kind {string} and source {string}',
  async function (this: LibrarianWorld, kind: string, source: string) {
    const res = await this.api('GET', '/api/decisions');
    const decisions = res.body.decisions as Array<Record<string, unknown>>;
    assert.equal(decisions.length, 1, 'the watcher should have captured exactly one decision');
    assert.equal(decisions[0].kind, kind);
    assert.equal(decisions[0].source, source);
  },
);

Then('its session external_ref points at the transcript', async function (this: LibrarianWorld) {
  const res = await this.api('GET', '/api/decisions');
  const decisions = res.body.decisions as Array<Record<string, unknown>>;
  const detail = await this.api('GET', `/api/decisions/${decisions[0].id}`);
  const provenance = detail.body.provenance as Array<Record<string, unknown>>;
  assert.ok(
    provenance.some((p) => typeof p.detail === 'string' && p.detail.endsWith('.jsonl')),
    'provenance should record the transcript it came from',
  );
});

Then('no decision is captured from it', async function (this: LibrarianWorld) {
  const res = await this.api('GET', '/api/decisions');
  const decisions = res.body.decisions as Array<Record<string, unknown>>;
  assert.equal(decisions.length, 0, 'a rejected plan is not a decision the agent may act on');
});

Then('exactly one decision exists', async function (this: LibrarianWorld) {
  const res = await this.api('GET', '/api/decisions');
  const decisions = res.body.decisions as Array<Record<string, unknown>>;
  assert.equal(decisions.length, 1, 'the same content from both paths must merge, not duplicate');
});

Then('both provenances are recorded', async function (this: LibrarianWorld) {
  const detail = await this.api('GET', `/api/decisions/${this.reviewId}`);
  const provenance = detail.body.provenance as Array<Record<string, unknown>>;
  const sources = provenance.map((p) => p.source).sort();
  assert.deepEqual(sources, ['mcp', 'watcher']);
});

// ---------- fixtures ----------

const SESSION_UUID = 'cfa8b3b5-aaf4-44f0-bed2-7061ca9cca08';
const TOOL_USE_ID = 'toolu_01CQXL79c7zdV7KaEhWm7ii7';

function transcriptPath(world: LibrarianWorld): string {
  return join(world.watchDir!, '-Users-x-Projects-accounting-app', `${SESSION_UUID}.jsonl`);
}

function writeTranscript(world: LibrarianWorld, lines: unknown[]): void {
  const path = transcriptPath(world);
  const payload = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  try {
    appendFileSync(path, payload);
  } catch {
    writeFileSync(path, payload);
  }
}

function approvedPlanLines(): unknown[] {
  const plan = '# Migrate chart rendering to Recharts\n\nSwap the chart library.';
  return [
    {
      type: 'assistant',
      uuid: 'a1111111-1111-1111-1111-111111111111',
      sessionId: SESSION_UUID,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'ExitPlanMode', input: { plan } }],
      },
    },
    {
      type: 'user',
      uuid: 'a2222222-2222-2222-2222-222222222222',
      sessionId: SESSION_UUID,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: TOOL_USE_ID,
            content: 'User has approved your plan.',
          },
        ],
      },
      toolUseResult: { plan, isAgent: false },
    },
  ];
}

function rejectedPlanLines(): unknown[] {
  const plan = '# Split backend into microservices\n\nSplit everything.';
  return [
    {
      type: 'assistant',
      uuid: 'b1111111-1111-1111-1111-111111111111',
      sessionId: SESSION_UUID,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_rejected_01', name: 'ExitPlanMode', input: { plan } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'b2222222-2222-2222-2222-222222222222',
      sessionId: SESSION_UUID,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_rejected_01',
            is_error: true,
            content: "The user doesn't want to proceed with this tool use.",
          },
        ],
      },
      toolUseResult: 'User rejected tool use',
    },
  ];
}

function docWriteLine(content: string): unknown {
  return {
    type: 'assistant',
    uuid: 'c1111111-1111-1111-1111-111111111111',
    sessionId: SESSION_UUID,
    cwd: '/Users/x/Projects/accounting-app',
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_write_01',
          name: 'Write',
          input: {
            file_path: '/Users/x/Projects/accounting-app/docs/adr/ADR-001-store.md',
            content,
          },
        },
      ],
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The watcher is async by nature; poll briefly rather than guess a delay. */
async function waitForCapture(world: LibrarianWorld, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await world.daemon!.watcher!.drain();
    const res = await world.api('GET', '/api/decisions');
    const decisions = res.body.decisions as Array<Record<string, unknown>>;
    if (decisions.some((d) => d.source === 'watcher')) return;
    await sleep(50);
  }
}

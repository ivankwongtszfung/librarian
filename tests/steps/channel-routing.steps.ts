import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { LibrarianWorld } from './world.js';

Given(
  'a channel session {string} bound to project {string}',
  async function (this: LibrarianWorld, label: string, project: string) {
    if (!this.daemon) await this.boot();
    await this.listenAs(label, project);
  },
);

Given(
  'a decision {string} submitted to project {string}',
  async function (this: LibrarianWorld, title: string, project: string) {
    const res = await this.callTool('submit_for_review', {
      project,
      title,
      doc: `# ${title}\n\nBody for ${title}.`,
      kind: 'adr',
    });
    this.reviewId = res.review_id as string;
  },
);

When(
  'a decision {string} is submitted to project {string}',
  async function (this: LibrarianWorld, title: string, project: string) {
    const res = await this.callTool('submit_for_review', {
      project,
      title,
      doc: `# ${title}\n\nBody for ${title}.`,
      kind: 'adr',
    });
    this.reviewId = res.review_id as string;
  },
);

When('the human approves it', async function (this: LibrarianWorld) {
  const res = await this.api('POST', `/api/decisions/${this.reviewId}/verdict`, { to: 'approved' });
  assert.equal(res.status, 200);
  await settle();
});

When(
  'the human rejects it with reason {string}',
  async function (this: LibrarianWorld, reason: string) {
    const res = await this.api('POST', `/api/decisions/${this.reviewId}/verdict`, {
      to: 'rejected',
      reason,
    });
    assert.equal(res.status, 200);
    await settle();
  },
);

When('the human comments on it', async function (this: LibrarianWorld) {
  const res = await this.api('POST', `/api/decisions/${this.reviewId}/comments`, {
    comments: [{ body: 'Tighten section two.' }],
  });
  assert.equal(res.status, 200);
  await settle();
});

Then(
  'the {string} session receives a {string} event',
  async function (this: LibrarianWorld, label: string, type: string) {
    await settle();
    const got = this.received(label, type);
    assert.ok(
      got.length > 0,
      `expected "${label}" to receive a ${type} event, but it received: ${JSON.stringify(
        (this.channels.get(label)?.events ?? []).map((e) => e.type),
      )}`,
    );
  },
);

Then(
  'the {string} session receives no {string} event',
  async function (this: LibrarianWorld, label: string, type: string) {
    await settle();
    const got = this.received(label, type);
    assert.equal(
      got.length,
      0,
      `"${label}" should not have been told about another project's ${type}, but received ${got.length}: ${JSON.stringify(got)}`,
    );
  },
);

/** SSE delivery is asynchronous; give the frame time to cross the socket.
 *  Deliberately generous — a flaky routing test is worse than a slow one. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 250));
}

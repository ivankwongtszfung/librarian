import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import type { LibrarianWorld } from './world.js';

When(
  'a client posts verdict {string} with reason {string}',
  async function (this: LibrarianWorld, to: string, reason: string) {
    // Unlike the "a human posts…" step this records the status rather than
    // asserting 200 — these scenarios are about which verdicts are allowed.
    const res = await this.api('POST', `/api/decisions/${this.reviewId}/verdict`, { to, reason });
    this.lastHttpStatus = res.status;
    this.lastHttpBody = res.body;
  },
);

Then('the constraints digest does not list it as accepted', async function (this: LibrarianWorld) {
  const digest = await this.callTool('get_constraints', { project: 'accounting_app' });
  const accepted = (digest.accepted ?? []) as Array<{ title: string }>;
  const detail = await this.api('GET', `/api/decisions/${this.reviewId}`);
  const title = detail.body.title as string;
  assert.ok(
    !accepted.some((a) => a.title === title),
    `a superseded record must not be served to agents as settled law, but "${title}" is still in the digest: ${JSON.stringify(accepted.map((a) => a.title))}`,
  );
});

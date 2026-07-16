import { strict as assert } from 'node:assert';
import { Then, When } from '@cucumber/cucumber';
import type { LibrarianWorld } from './world.js';

When(
  'an agent comments {string} as {string}',
  async function (this: LibrarianWorld, body: string, as: string) {
    this.lastToolResult = await this.callTool('comment_on_decision', {
      review_id: this.reviewId,
      body,
      as,
    });
  },
);

When(
  'an agent comments {string} anchored to {string} as {string}',
  async function (this: LibrarianWorld, body: string, quote: string, as: string) {
    this.lastToolResult = await this.callTool('comment_on_decision', {
      review_id: this.reviewId,
      body,
      anchor_quote: quote,
      as,
    });
  },
);

When('a human comments {string}', async function (this: LibrarianWorld, body: string) {
  const res = await this.api('POST', `/api/decisions/${this.reviewId}/comments`, {
    comments: [{ body }],
  });
  assert.equal(res.status, 200);
});

When('an agent tries to comment with request_changes set', async function (this: LibrarianWorld) {
  // The MCP tool deliberately exposes no way to do this — an agent's only route
  // to the comment path cannot carry a verdict. Prove it at the service seam,
  // which is what an in-process caller (a future reviewer panel) would reach.
  assert.throws(
    () =>
      this.daemon!.reviews.postComments({
        decisionId: this.reviewId!,
        comments: [{ body: 'I insist this be revised' }],
        by: 'security',
        authorType: 'reviewer',
        requestChanges: true,
        reason: 'I insist',
      }),
    /only a human may transition a verdict/,
  );
});

Then(
  'the comment is stored, authored by the agent {string}',
  async function (this: LibrarianWorld, name: string) {
    const outcome = this.daemon!.repo.reviewOutcome(this.reviewId!)!;
    assert.equal(outcome.comments.length, 1);
    assert.equal(outcome.comments[0].author, name);
    assert.equal(
      outcome.comments[0].authorType,
      'reviewer',
      'a role-scoped critic is recorded as a reviewer, not a human',
    );
  },
);

Then('get_review returns {int} comments', async function (this: LibrarianWorld, n: number) {
  const result = await this.callTool('get_review', { review_id: this.reviewId, wait_seconds: 0 });
  const comments = result.comments as Array<Record<string, unknown>>;
  assert.equal(comments.length, n);
});

Then(
  'the thread distinguishes the agent author from the human author',
  function (this: LibrarianWorld) {
    const outcome = this.daemon!.repo.reviewOutcome(this.reviewId!)!;
    const types = outcome.comments.map((c) => c.authorType).sort();
    assert.deepEqual(
      types,
      ['human', 'reviewer'],
      'the thread must record who is speaking — the rationale is multi-party',
    );
  },
);

Then('the stored comment carries that anchor quote', function (this: LibrarianWorld) {
  const outcome = this.daemon!.repo.reviewOutcome(this.reviewId!)!;
  assert.equal(outcome.comments[0].anchorQuote, 'store sessions in Redis');
});

Then(
  'the decision status is still {string}',
  async function (this: LibrarianWorld, status: string) {
    const detail = await this.api('GET', `/api/decisions/${this.reviewId}`);
    assert.equal(detail.body.status, status, 'a comment is not a verdict');
  },
);

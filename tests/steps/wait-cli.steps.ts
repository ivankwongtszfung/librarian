import { strict as assert } from 'node:assert';
import { Given, Then, When } from '@cucumber/cucumber';
import type { LibrarianWorld } from './world.js';

Given(
  'librarian wait is started for the review with a {int}s timeout',
  async function (this: LibrarianWorld, timeoutSeconds: number) {
    await this.startWaiter(this.reviewId!, timeoutSeconds);
  },
);

Given(
  'librarian wait is started for review id {string} with a {int}s timeout',
  async function (this: LibrarianWorld, reviewId: string, timeoutSeconds: number) {
    await this.startWaiter(reviewId, timeoutSeconds);
  },
);

When(
  'a human posts verdict {string} while the waiter is holding',
  async function (this: LibrarianWorld, to: string) {
    const res = await this.api('POST', `/api/decisions/${this.reviewId}/verdict`, { to });
    assert.equal(res.status, 200);
  },
);

Then(
  'the wait process exits {int} within {int}s',
  async function (this: LibrarianWorld, code: number, seconds: number) {
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), seconds * 1000).unref(),
    );
    const result = await Promise.race([this.waiterExit!, timeout]);
    assert.notEqual(
      result,
      'timeout',
      `waiter still running after ${seconds}s; stderr so far:\n${this.waiterStderr}`,
    );
    assert.equal(
      result,
      code,
      `expected exit ${code}, got ${result}; stderr:\n${this.waiterStderr}`,
    );
  },
);

Then(
  "the waiter's stdout is one JSON line with status {string}",
  function (this: LibrarianWorld, status: string) {
    const lines = this.waiterStdout.trim().split('\n');
    assert.equal(lines.length, 1, `expected exactly one stdout line, got:\n${this.waiterStdout}`);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(parsed.status, status);
  },
);

Then(
  "the waiter's stdout carries the reason {string}",
  function (this: LibrarianWorld, reason: string) {
    const parsed = JSON.parse(this.waiterStdout.trim()) as Record<string, unknown>;
    assert.equal(parsed.reason, reason);
  },
);

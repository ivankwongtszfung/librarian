import type { DecisionStatus } from './domain/types.js';
import { isResolved } from './domain/types.js';

export interface WaitOptions {
  reviewId: string;
  /** Daemon base URL, e.g. http://127.0.0.1:7801 */
  url: string;
  token?: string;
  timeoutSeconds: number;
  /** Progress reporting (goes to stderr in the CLI); never part of the result. */
  log?: (line: string) => void;
}

export interface WaitResult {
  /** 0 = resolved, 1 = error, 2 = timed out still pending. */
  exitCode: 0 | 1 | 2;
  /** Exactly one JSON-serializable object — the process's stdout contract. */
  output: Record<string, unknown>;
}

const MAX_HOLD_SECONDS = 50;

/**
 * Hold open the review long-poll until the verdict lands, the deadline passes,
 * or the review turns out not to exist. This is the engine of `librarian wait`:
 * a background process whose exit *is* the notification, so an agent can launch
 * it, end its turn, and be re-invoked by its harness with the verdict.
 *
 * The daemon being down is treated as latency, not loss — the verdict is
 * committed rows, so we keep knocking with backoff until the deadline. That
 * mirrors the long-poll invariant: losing a connection costs time, never a
 * verdict.
 */
export async function waitForVerdict(opts: WaitOptions): Promise<WaitResult> {
  const log = opts.log ?? (() => {});
  const base = opts.url.replace(/\/+$/, '');
  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  let backoffMs = 500;
  let last: Record<string, unknown> | undefined;

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { exitCode: 2, output: last ?? { status: 'pending', review_id: opts.reviewId } };
    }
    const hold = Math.max(1, Math.min(MAX_HOLD_SECONDS, Math.floor(remainingMs / 1000)));

    try {
      const res = await fetch(
        `${base}/api/decisions/${encodeURIComponent(opts.reviewId)}/review?wait_seconds=${hold}`,
        {
          headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
          // The server holds for `hold` seconds; anything much beyond that is a
          // wedged connection, not a slow verdict.
          signal: AbortSignal.timeout((hold + 15) * 1000),
        },
      );

      if (res.status === 404) {
        return { exitCode: 1, output: { error: 'not_found', review_id: opts.reviewId } };
      }
      if (res.status === 401) {
        return { exitCode: 1, output: { error: 'unauthorized' } };
      }
      if (!res.ok) throw new Error(`daemon answered ${res.status}`);

      const outcome = (await res.json()) as Record<string, unknown>;
      last = outcome;
      backoffMs = 500;
      if (isResolved(outcome.status as DecisionStatus)) {
        return { exitCode: 0, output: outcome };
      }
    } catch (err) {
      const wait = Math.min(backoffMs, Math.max(0, deadline - Date.now()));
      log(
        `daemon unreachable (${err instanceof Error ? err.message : String(err)}); retrying in ${wait}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
      backoffMs = Math.min(backoffMs * 2, 5000);
    }
  }
}

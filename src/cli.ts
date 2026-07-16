#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { startDaemon } from './daemon.js';
import { parseDuration } from './util/duration.js';
import { waitForVerdict } from './wait.js';

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * `librarian wait <review_id>` — block until the human decides, then exit.
 *
 * Made for backgrounding: an agent launches it as a background task, ends its
 * turn, and its harness re-invokes the agent when the process exits with the
 * verdict JSON on stdout. Exit codes are the contract: 0 = resolved,
 * 1 = error, 2 = timeout with the review still pending.
 */
async function runWait(): Promise<void> {
  const reviewId = process.argv[3];
  if (!reviewId || reviewId.startsWith('--')) {
    console.error(
      'usage: librarian wait <review_id> [--url <base>] [--token <secret>] [--timeout <e.g. 90s|30m|2h>]',
    );
    process.exitCode = 1;
    return;
  }

  const url = arg('url') ?? process.env.LIBRARIAN_URL ?? 'http://127.0.0.1:7801';
  const timeoutSeconds = parseDuration(arg('timeout') ?? '2h');
  console.error(
    `librarian wait: holding for verdict on ${reviewId} (timeout ${timeoutSeconds}s, ${url})`,
  );

  const result = await waitForVerdict({
    reviewId,
    url,
    token: arg('token') ?? process.env.LIBRARIAN_TOKEN,
    timeoutSeconds,
    log: (line) => console.error(`librarian wait: ${line}`),
  });

  if (result.exitCode === 2) {
    console.error('librarian wait: timed out with the review still pending');
  }
  console.log(JSON.stringify(result.output));
  process.exitCode = result.exitCode;
}

async function main(): Promise<void> {
  if (process.argv[2] === 'wait') {
    await runWait();
    return;
  }

  if (has('help')) {
    console.log(`librarian — a decision library for AI agent sessions

  librarian [options]              start the daemon
  librarian wait <review_id>       block until the verdict, then exit
                                   (0 = resolved, 1 = error, 2 = still pending;
                                    verdict JSON on stdout — run it in the
                                    background and let the exit wake your agent)

Daemon options:
  --port <n>        HTTP port (default 7801)
  --host <addr>     bind address (default 127.0.0.1)
  --db <path>       SQLite file (default ~/.librarian/librarian.db)
  --token <secret>  require a bearer token on /api
  --ntfy <url>      ntfy topic URL for push notifications
  --watch [dir]     auto-capture decisions from agent transcripts
                    (default ~/.claude/projects)
  --no-watch        disable transcript capture

Wait options:
  --url <base>      daemon base URL (default http://127.0.0.1:7801, or LIBRARIAN_URL)
  --token <secret>  bearer token (or LIBRARIAN_TOKEN)
  --timeout <dur>   give up after this long, e.g. 90s, 30m, 2h (default 2h)

Point your agent at it:
  claude mcp add --transport http librarian http://127.0.0.1:7801/mcp
`);
    return;
  }

  const dbPath = arg('db') ?? join(homedir(), '.librarian', 'librarian.db');
  mkdirSync(dirname(dbPath), { recursive: true });

  const watchDir = has('no-watch')
    ? undefined
    : (arg('watch') ?? join(homedir(), '.claude', 'projects'));

  const daemon = await startDaemon({
    dbPath,
    port: Number(arg('port') ?? 7801),
    host: arg('host') ?? '127.0.0.1',
    token: arg('token') ?? process.env.LIBRARIAN_TOKEN,
    ntfyTopic: arg('ntfy') ?? process.env.LIBRARIAN_NTFY,
    watchDir,
  });

  console.log(`librarian listening on ${daemon.baseUrl}`);
  console.log(`  library   ${daemon.baseUrl}/`);
  console.log(`  mcp       ${daemon.baseUrl}/mcp`);
  console.log(`  store     ${dbPath}`);
  if (watchDir) console.log(`  watching  ${watchDir}`);

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

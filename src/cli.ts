#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { startDaemon } from './daemon.js';

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

async function main(): Promise<void> {
  if (has('help')) {
    console.log(`librarian — a decision library for AI agent sessions

  librarian [options]

  --port <n>        HTTP port (default 7801)
  --host <addr>     bind address (default 127.0.0.1)
  --db <path>       SQLite file (default ~/.librarian/librarian.db)
  --token <secret>  require a bearer token on /api
  --ntfy <url>      ntfy topic URL for push notifications
  --watch [dir]     auto-capture decisions from agent transcripts
                    (default ~/.claude/projects)
  --no-watch        disable transcript capture

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

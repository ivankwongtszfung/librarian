#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportLibrary } from '../application/export.js';
import {
  SERVICE_LABEL,
  type ServiceSpec,
  installService,
  uninstallService,
} from '../infrastructure/service/install.js';
import { openDb } from '../infrastructure/store/db.js';
import { Repository } from '../infrastructure/store/repository.js';
import { runChannel } from '../interfaces/mcp/channel.js';
import { parseDuration } from '../util/duration.js';
import { errFields, log } from '../util/logger.js';
import { startDaemon } from './daemon.js';
import { waitForVerdict } from './wait.js';

// Crash supervision: an unexpected throw in an always-on daemon must be logged
// and surface a non-zero exit so the service supervisor restarts it, rather than
// dying silently. Registered at load, before anything can throw.
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', errFields(err));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', errFields(reason));
  process.exit(1);
});

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

function defaultDbPath(): string {
  return arg('db') ?? join(homedir(), '.librarian', 'librarian.db');
}

/**
 * `librarian wait <review_id>` — block until the human decides, then exit.
 * Built for backgrounding: exit codes are the contract (0 resolved, 1 error,
 * 2 timed-out-pending) and the verdict JSON lands on stdout.
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

/** `librarian export` — dump the archive as JSON (backup) or markdown (digest). */
function runExport(): void {
  const dbPath = defaultDbPath();
  const db = openDb(dbPath);
  try {
    const store = new Repository(db);
    const format = arg('format') === 'md' ? 'md' : 'json';
    const out = exportLibrary(store, { format, project: arg('project') });
    const outFile = arg('out');
    if (outFile) {
      writeFileSync(outFile, out);
      console.error(`librarian export: wrote ${outFile}`);
    } else {
      process.stdout.write(`${out}\n`);
    }
  } finally {
    db.close();
  }
}

/** `librarian install` — register the daemon as a per-user background service. */
function runInstall(): void {
  const daemonArgs = process.argv.slice(3); // pass-through daemon flags (--port, --db, ...)
  const spec: ServiceSpec = {
    label: SERVICE_LABEL,
    nodePath: process.execPath,
    scriptPath: fileURLToPath(import.meta.url),
    args: daemonArgs,
    logFile: join(homedir(), '.librarian', 'librarian.log'),
  };
  mkdirSync(join(homedir(), '.librarian'), { recursive: true });
  const result = installService(spec);
  console.log(`librarian installed as a ${result.platform} service`);
  console.log(`  unit    ${result.path}`);
  console.log(`  logs    ${spec.logFile}`);
  console.log('  remove  librarian uninstall');
}

function runUninstall(): void {
  uninstallService();
  console.log('librarian service removed.');
}

async function runDaemon(): Promise<void> {
  const dbPath = defaultDbPath();
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

  log.info('librarian listening', {
    url: daemon.baseUrl,
    mcp: `${daemon.baseUrl}/mcp`,
    store: dbPath,
    watching: watchDir ?? null,
  });

  const shutdown = async () => {
    log.info('librarian shutting down');
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const HELP = `librarian — a decision library for AI agent sessions

  librarian [options]              start the daemon (foreground)
  librarian install [options]      run the daemon as a background service
  librarian uninstall              remove the background service
  librarian export [--format md]   dump the archive (json default) to stdout or --out
  librarian wait <review_id>       block until the verdict, then exit
                                   (0 = resolved, 1 = error, 2 = still pending)
  librarian channel                stdio MCP server that pushes verdicts as agent
                                   turns; launch your agent with --channels librarian-channel

Daemon options:
  --port <n>        HTTP port (default 7801)
  --host <addr>     bind address (default 127.0.0.1)
  --db <path>       SQLite file (default ~/.librarian/librarian.db)
  --token <secret>  require a bearer token (mandatory for a non-loopback host)
  --ntfy <url>      ntfy topic URL for push notifications
  --watch [dir]     auto-capture decisions from agent transcripts
                    (default ~/.claude/projects)
  --no-watch        disable transcript capture

Export options:
  --format <fmt>    json (default) or md
  --project <name>  limit to one project
  --out <file>      write to a file instead of stdout

Env: LIBRARIAN_TOKEN, LIBRARIAN_NTFY, LIBRARIAN_URL, LIBRARIAN_LOG_LEVEL

Point your agent at it:
  claude mcp add --transport http librarian http://127.0.0.1:7801/mcp
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (has('help') || cmd === 'help') {
    console.log(HELP);
    return;
  }
  switch (cmd) {
    case 'wait':
      return runWait();
    case 'export':
      return runExport();
    case 'install':
      return runInstall();
    case 'uninstall':
      return runUninstall();
    case 'channel':
      return runChannel();
    default:
      return runDaemon();
  }
}

main().catch((err) => {
  log.error('fatal', errFields(err));
  process.exit(1);
});

import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from './core/events.js';
import { MemoryNotifier, type Notifier, NtfyNotifier } from './core/notifier.js';
import { ReviewService } from './core/review-service.js';
import { createApp } from './http/server.js';
import { type Db, openDb } from './store/db.js';
import { Repository } from './store/repository.js';
import { TranscriptWatcher } from './watcher/watcher.js';

export interface DaemonOptions {
  dbPath: string;
  port?: number;
  host?: string;
  token?: string;
  ntfyTopic?: string;
  /** Directory of agent transcripts to auto-capture from. Omit to disable. */
  watchDir?: string;
  publicDir?: string;
  notifier?: Notifier;
}

export interface Daemon {
  db: Db;
  repo: Repository;
  reviews: ReviewService;
  bus: EventBus;
  notifier: Notifier;
  watcher?: TranscriptWatcher;
  server: Server;
  port: number;
  baseUrl: string;
  stop(): Promise<void>;
}

const DEFAULT_PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Loopback addresses need no token; anything else is reachable by others. */
function isLoopback(host: string): boolean {
  return (
    host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1' || host.startsWith('127.')
  );
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const host = opts.host ?? '127.0.0.1';
  // An exposed daemon must require auth. Refuse to even start bound to anything
  // but loopback without a token — the dangerous configuration is made
  // impossible rather than merely discouraged. (Threat model F3.)
  if (!isLoopback(host) && !opts.token) {
    throw new Error(
      `librarian: refusing to bind to non-loopback address "${host}" without a token. A LAN- or internet-reachable daemon must require auth — pass a token, or bind to 127.0.0.1.`,
    );
  }

  const db = openDb(opts.dbPath);
  const repo = new Repository(db);
  const bus = new EventBus();
  const notifier =
    opts.notifier ?? (opts.ntfyTopic ? new NtfyNotifier(opts.ntfyTopic) : new MemoryNotifier());

  const port = opts.port ?? 7801;
  const baseUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

  const reviews = new ReviewService(repo, bus, notifier, baseUrl);
  const app = createApp({
    repo,
    reviews,
    bus,
    token: opts.token,
    publicDir: opts.publicDir ?? DEFAULT_PUBLIC,
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });

  // Node aborts any request still open after 300s. A long-poll can legitimately
  // hold for 50s and an SSE stream holds indefinitely, so the cap has to go.
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  let watcher: TranscriptWatcher | undefined;
  if (opts.watchDir) {
    watcher = new TranscriptWatcher(opts.watchDir, repo, bus);
    await watcher.start();
  }

  const actualPort = (server.address() as { port: number }).port;

  return {
    db,
    repo,
    reviews,
    bus,
    notifier,
    watcher,
    server,
    port: actualPort,
    baseUrl: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
    async stop() {
      await watcher?.stop();
      // Long-poll and SSE need the request timeouts disabled, which means idle
      // keep-alive sockets never expire on their own — so close() would wait
      // forever for them. Cut them explicitly, or the daemon can't shut down.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

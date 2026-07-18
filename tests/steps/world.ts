import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Before, setWorldConstructor } from '@cucumber/cucumber';
import { World } from '@cucumber/cucumber';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { LibrarianEvent } from '../../src/application/events.js';
import { MemoryNotifier } from '../../src/infrastructure/notify/notifier.js';
import { type Daemon, startDaemon } from '../../src/main/daemon.js';

/**
 * The BDD world drives a real daemon over real HTTP with a real MCP client —
 * no mocks in the middle. If a scenario passes here, an agent can do it.
 */
export class LibrarianWorld extends World {
  daemon?: Daemon;
  client?: Client;
  notifier = new MemoryNotifier();
  events: LibrarianEvent[] = [];
  tmpDir = '';
  dbPath = '';
  watchDir?: string;

  reviewId?: string;
  lastToolResult?: Record<string, unknown>;
  lastHttpStatus?: number;
  lastHttpBody?: Record<string, unknown>;
  inFlight?: Promise<Record<string, unknown>>;
  inFlightAbort?: AbortController;
  pollStartedAt?: number;

  /** Kept across restarts so a waiter pointed at the old URL can reconnect —
   *  in production the daemon always comes back on its configured port. */
  port?: number;
  waiter?: ChildProcess;
  waiterStdout = '';
  waiterStderr = '';
  waiterExit?: Promise<number | null>;

  async boot(): Promise<void> {
    this.tmpDir = mkdtempSync(join(tmpdir(), 'librarian-bdd-'));
    this.dbPath = join(this.tmpDir, 'test.db');
    await this.start();
  }

  /** Start (or restart) the daemon against the same store — used to prove a
   *  pending review survives a restart. */
  async start(): Promise<void> {
    this.daemon = await startDaemon({
      dbPath: this.dbPath,
      port: this.port ?? 0,
      notifier: this.notifier,
      watchDir: this.watchDir,
      publicDir: undefined,
    });
    this.port = Number(new URL(this.daemon.baseUrl).port);
    this.daemon.bus.on('event', (e: LibrarianEvent) => this.events.push(e));
    await this.waitForHealth();
    await this.connectClient();
  }

  /** After a same-port restart, undici's keep-alive pool still holds sockets
   *  the old daemon force-closed; requests fail until the dead ones are
   *  evicted. Production clients (the wait CLI, agents) already retry — the
   *  test world has to as well. */
  private async waitForHealth(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/api/health`);
        if (res.ok) return;
      } catch {
        /* stale pooled socket — retrying evicts it */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('daemon did not become healthy after start');
  }

  /** Spawn the real CLI as a real child process — the exit-is-the-notification
   *  contract can only be tested from outside. */
  async startWaiter(reviewId: string, timeoutSeconds: number): Promise<void> {
    this.waiterStdout = '';
    this.waiterStderr = '';
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/main/cli.ts',
        'wait',
        reviewId,
        '--url',
        this.baseUrl,
        '--timeout',
        `${timeoutSeconds}s`,
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (d: Buffer) => {
      this.waiterStdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      this.waiterStderr += d.toString();
    });
    this.waiter = child;
    this.waiterExit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

    // Don't hand control back until the waiter is actually holding — the
    // scenarios race a verdict against it, and a verdict that lands before the
    // first poll must still be seen (idempotent read), but the "wakes on the
    // verdict" timing assertions need the hold to be established.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !this.waiterStderr.includes('holding for verdict')) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** A fresh agent connection to the daemon that is already running. Retries
   *  because the shared fetch pool may hand it one more dead socket even after
   *  waitForHealth has succeeded. */
  async connectClient(): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const transport = new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp`));
        this.client = new Client({ name: 'bdd-agent', version: '1.0.0' });
        await this.client.connect(transport);
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw lastErr;
  }

  get baseUrl(): string {
    if (!this.daemon) throw new Error('daemon not started');
    return this.daemon.baseUrl;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = (await this.client!.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
    };
    const first = result.content.find((c) => c.type === 'text');
    return first ? (JSON.parse(first.text) as Record<string, unknown>) : {};
  }

  async api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  }

  async shutdown(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      /* the transport may already be gone */
    }
    await this.daemon?.stop();
    this.daemon = undefined;
    this.client = undefined;
  }

  async destroy(): Promise<void> {
    if (this.waiter && this.waiter.exitCode === null) {
      this.waiter.kill('SIGKILL');
      await this.waiterExit;
    }
    this.waiter = undefined;
    await this.shutdown();
    if (this.tmpDir) rmSync(this.tmpDir, { recursive: true, force: true });
  }
}

setWorldConstructor(LibrarianWorld);

Before(function (this: LibrarianWorld) {
  this.events = [];
});

After(async function (this: LibrarianWorld) {
  await this.destroy();
});

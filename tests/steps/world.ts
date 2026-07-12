import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Before, setWorldConstructor } from '@cucumber/cucumber';
import { World } from '@cucumber/cucumber';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { LibrarianEvent } from '../../src/core/events.js';
import { MemoryNotifier } from '../../src/core/notifier.js';
import { type Daemon, startDaemon } from '../../src/daemon.js';

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
      port: 0,
      notifier: this.notifier,
      watchDir: this.watchDir,
      publicDir: undefined,
    });
    this.daemon.bus.on('event', (e: LibrarianEvent) => this.events.push(e));
    await this.connectClient();
  }

  /** A fresh agent connection to the daemon that is already running. */
  async connectClient(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp`));
    this.client = new Client({ name: 'bdd-agent', version: '1.0.0' });
    await this.client.connect(transport);
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

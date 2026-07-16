import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Daemon, startDaemon } from '../../src/daemon.js';

// Regression guards for the threat-model findings F2 (/mcp was ungated) and
// F3 (token optional / non-constant-time / accepted in the query string).
describe('http auth surface', () => {
  const TOKEN = 'a-high-entropy-token-0123456789abcdef';
  let dir: string;
  let daemon: Daemon | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'librarian-auth-'));
  });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(token?: string): Promise<string> {
    daemon = await startDaemon({ dbPath: join(dir, 'db.sqlite'), port: 0, token });
    return daemon.baseUrl;
  }

  it('rejects /api with no credential when a token is set', async () => {
    const base = await start(TOKEN);
    expect((await fetch(`${base}/api/decisions`)).status).toBe(401);
  });

  it('accepts /api with the correct bearer token', async () => {
    const base = await start(TOKEN);
    const res = await fetch(`${base}/api/decisions`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong bearer token', async () => {
    const base = await start(TOKEN);
    const res = await fetch(`${base}/api/decisions`, {
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(res.status).toBe(401);
  });

  // F3: the query-string token leaked into logs / Referer / the push URL.
  it('no longer accepts the token via the query string', async () => {
    const base = await start(TOKEN);
    expect((await fetch(`${base}/api/decisions?token=${TOKEN}`)).status).toBe(401);
  });

  // F2: /mcp used to be ungated because it was assumed localhost-only.
  it('gates /mcp with the same token, not just /api', async () => {
    const base = await start(TOKEN);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  // The header→cookie bootstrap is what lets a browser EventSource authenticate
  // without a header (impossible) or a query-string token (leaky).
  it('hands back an HttpOnly cookie after a valid header auth', async () => {
    const base = await start(TOKEN);
    const res = await fetch(`${base}/api/decisions`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const set = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
    const joined = set.join(' ');
    expect(joined).toContain('librarian_token=');
    expect(joined.toLowerCase()).toContain('httponly');
  });

  it('leaves the local default open: loopback with no token needs no auth', async () => {
    const base = await start(undefined);
    expect((await fetch(`${base}/api/decisions`)).status).toBe(200);
  });

  // F3: an exposed daemon must require auth — refuse to even start otherwise.
  it('refuses to bind to a non-loopback address without a token', async () => {
    await expect(
      startDaemon({ dbPath: join(dir, 'exposed.sqlite'), port: 0, host: '0.0.0.0' }),
    ).rejects.toThrow(/non-loopback|token/i);
  });
});

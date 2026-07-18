// ADR-011 presence hooks: two entries in ~/.claude/settings.json that tell the
// daemon when the agent starts (UserPromptSubmit) and finishes (Stop) a turn.
// Fire-and-forget curls — zero tokens, ~10ms, and a 1s timeout so a downed
// daemon can never slow the agent. The merge functions are pure (and tested);
// install/uninstall are the side-effectful wrappers.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Marker every hook we own carries — how uninstall finds ours and only ours. */
export const HOOK_MARKER = '/api/presence';

type HookEntry = { hooks: Array<{ type: string; command: string }> };
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

export function presenceCommand(state: 'working' | 'idle', baseUrl: string): string {
  return `curl -s -m 1 -X POST ${baseUrl}${HOOK_MARKER} -H 'content-type: application/json' -d '{"state":"${state}"}' >/dev/null 2>&1 || true`;
}

/** Pure: returns settings with the two presence hooks merged in (idempotent). */
export function withPresenceHooks(settings: Settings, baseUrl: string): Settings {
  const out: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const add = (event: string, state: 'working' | 'idle') => {
    const existing = out.hooks![event] ?? [];
    const already = existing.some((e) => e.hooks?.some((h) => h.command?.includes(HOOK_MARKER)));
    if (already) return;
    out.hooks![event] = [
      ...existing,
      { hooks: [{ type: 'command', command: presenceCommand(state, baseUrl) }] },
    ];
  };
  add('UserPromptSubmit', 'working');
  add('Stop', 'idle');
  return out;
}

/** Pure: returns settings with every presence hook removed; other hooks kept. */
export function withoutPresenceHooks(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks)) {
    const kept = entries.filter((e) => !e.hooks?.some((h) => h.command?.includes(HOOK_MARKER)));
    if (kept.length) hooks[event] = kept;
  }
  return { ...settings, hooks };
}

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

export function installPresenceHooks(baseUrl: string, path = SETTINGS_PATH): void {
  const current: Settings = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Settings)
    : {};
  writeFileSync(path, `${JSON.stringify(withPresenceHooks(current, baseUrl), null, 2)}\n`);
}

export function uninstallPresenceHooks(path = SETTINGS_PATH): void {
  if (!existsSync(path)) return;
  const current = JSON.parse(readFileSync(path, 'utf8')) as Settings;
  writeFileSync(path, `${JSON.stringify(withoutPresenceHooks(current), null, 2)}\n`);
}

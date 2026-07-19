import { describe, expect, it } from 'vitest';
import { ChannelRegistry } from '../../src/application/channel-registry.js';

// ADR-013: the registry knows whether a home exists, so a targeted message
// parks instead of being delivered into the void.
// ADR-016: a session's project is a BINDING the registry holds — cwd only seeds
// the default — so a human can rebind a live session and routing follows.

describe('ChannelRegistry', () => {
  it('registers a session and reports the project it is bound to', () => {
    const reg = new ChannelRegistry();
    expect(reg.hasProject('acct')).toBe(false);
    expect(reg.hasAny()).toBe(false);

    reg.register('ses_1', { cwd: '/Users/x/Projects/acct', projects: ['acct'] });
    expect(reg.hasProject('acct')).toBe(true);
    expect(reg.hasAny()).toBe(true);
    expect(reg.projectsOf('ses_1')).toEqual(['acct']);

    reg.unregister('ses_1');
    expect(reg.hasProject('acct')).toBe(false);
    expect(reg.hasAny()).toBe(false);
  });

  it('rebinds a live session — the bug that forced ADR-016', () => {
    const reg = new ChannelRegistry();
    // Launched from all_state, but the work is on librarian.
    reg.register('ses_1', { cwd: '/Users/x/Projects/all_state', projects: ['all_state'] });
    expect(reg.hasProject('librarian')).toBe(false); // message would park

    const bound = reg.bind('ses_1', ['librarian']);
    expect(bound?.projects).toEqual(['librarian']);
    expect(reg.hasProject('librarian')).toBe(true); // now it has a home
    expect(reg.hasProject('all_state')).toBe(false);
    expect(reg.projectsOf('ses_1')).toEqual(['librarian']);
  });

  it('holds several projects at once', () => {
    const reg = new ChannelRegistry();
    reg.register('ses_1', { projects: ['librarian', 'all_state'] });
    expect(reg.hasProject('librarian')).toBe(true);
    expect(reg.hasProject('all_state')).toBe(true);
    expect(reg.projectsOf('ses_1')).toEqual(['librarian', 'all_state']);
  });

  it('dedupes and trims bound projects', () => {
    const reg = new ChannelRegistry();
    reg.register('ses_1', { projects: [' librarian ', 'librarian', '', 'acct'] });
    expect(reg.projectsOf('ses_1')).toEqual(['librarian', 'acct']);
  });

  it('binding an unknown session is a no-op, not a crash', () => {
    const reg = new ChannelRegistry();
    expect(reg.bind('ses_ghost', ['x'])).toBeNull();
  });

  it('keeps sessions independent and lists them', () => {
    const reg = new ChannelRegistry();
    reg.register('ses_a', { cwd: '/a', projects: ['a'], at: 1 });
    reg.register('ses_b', { cwd: '/b', projects: ['b'], at: 2 });

    expect(reg.list().map((s) => s.key)).toEqual(['ses_a', 'ses_b']); // oldest first
    reg.unregister('ses_a');
    expect(reg.hasProject('a')).toBe(false);
    expect(reg.hasProject('b')).toBe(true);
    expect(reg.list()).toHaveLength(1);
  });

  it('a reconnect with the same key replaces the entry, never duplicates', () => {
    const reg = new ChannelRegistry();
    reg.register('ses_1', { projects: ['acct'] });
    reg.register('ses_1', { projects: ['librarian'] });
    expect(reg.list()).toHaveLength(1);
    expect(reg.projectsOf('ses_1')).toEqual(['librarian']);
  });

  it('an unknown key has no binding, so it is never filtered', () => {
    const reg = new ChannelRegistry();
    expect(reg.projectsOf(undefined)).toEqual([]);
    expect(reg.projectsOf('nope')).toEqual([]);
  });
});

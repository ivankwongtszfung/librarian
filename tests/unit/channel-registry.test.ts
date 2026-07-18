import { describe, expect, it } from 'vitest';
import { ChannelRegistry } from '../../src/application/channel-registry.js';

// ADR-013: the registry knows which projects have a live session, so a targeted
// message with no home stays queued instead of being delivered into the void.

describe('ChannelRegistry', () => {
  it('tracks presence of a project across connect/disconnect', () => {
    const reg = new ChannelRegistry();
    expect(reg.hasProject('acct')).toBe(false);
    expect(reg.hasAny()).toBe(false);

    reg.add('acct');
    expect(reg.hasProject('acct')).toBe(true);
    expect(reg.hasAny()).toBe(true);
    expect(reg.projects()).toEqual(['acct']);

    reg.remove('acct');
    expect(reg.hasProject('acct')).toBe(false);
    expect(reg.hasAny()).toBe(false);
    expect(reg.projects()).toEqual([]);
  });

  it('reference-counts multiple sessions of the same project', () => {
    const reg = new ChannelRegistry();
    reg.add('librarian');
    reg.add('librarian'); // two windows, same project
    reg.remove('librarian');
    expect(reg.hasProject('librarian')).toBe(true); // still one left
    reg.remove('librarian');
    expect(reg.hasProject('librarian')).toBe(false);
  });

  it('an over-remove never drops the count below zero', () => {
    const reg = new ChannelRegistry();
    reg.remove('ghost'); // never added
    reg.add('ghost');
    reg.remove('ghost');
    reg.remove('ghost'); // extra
    expect(reg.hasProject('ghost')).toBe(false);
    reg.add('ghost'); // and it still works afterwards
    expect(reg.hasProject('ghost')).toBe(true);
  });

  it('keeps projects independent', () => {
    const reg = new ChannelRegistry();
    reg.add('a');
    reg.add('b');
    reg.remove('a');
    expect(reg.hasProject('a')).toBe(false);
    expect(reg.hasProject('b')).toBe(true);
    expect(reg.hasAny()).toBe(true);
  });
});

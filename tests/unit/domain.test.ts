import { describe, expect, it } from 'vitest';
import { VerdictError, assertTransition, canTransition } from '../../src/domain/state-machine.js';
import { unifiedDiff } from '../../src/util/diff.js';

describe('verdict state machine', () => {
  it('allows a pending decision to be approved or rejected', () => {
    expect(canTransition('pending', 'approved')).toBe(true);
    expect(canTransition('pending', 'rejected')).toBe(true);
    expect(canTransition('pending', 'changes_requested')).toBe(true);
  });

  it('will not re-decide a settled decision', () => {
    expect(canTransition('approved', 'rejected')).toBe(false);
    expect(() => assertTransition('approved', 'rejected', 'changed my mind')).toThrow(VerdictError);
  });

  it('lets a later version supersede a settled one without erasing it', () => {
    expect(canTransition('rejected', 'superseded')).toBe(true);
    expect(canTransition('approved', 'superseded')).toBe(true);
  });

  it('requires a reason for a red light', () => {
    expect(() => assertTransition('pending', 'rejected', null)).toThrow(/must carry a reason/);
    expect(() => assertTransition('pending', 'rejected', 'conflicts with ADR-004')).not.toThrow();
  });

  it('requires a reason when asking for changes', () => {
    expect(() => assertTransition('pending', 'changes_requested', '')).toThrow(VerdictError);
  });

  it('does not require a reason for a green light', () => {
    expect(() => assertTransition('pending', 'approved', null)).not.toThrow();
  });
});

describe('unified diff', () => {
  it('is empty when nothing changed', () => {
    expect(unifiedDiff('same\ntext', 'same\ntext', 'v1', 'v2')).toBe('');
  });

  it('shows what the red light changed', () => {
    const v1 = '# Plan\n\nWe will use Redis for sessions.\n\nDone.';
    const v2 = '# Plan\n\nWe will use SQLite for sessions.\n\nDone.';
    const diff = unifiedDiff(v1, v2, 'v1', 'v2');

    expect(diff).toContain('-We will use Redis for sessions.');
    expect(diff).toContain('+We will use SQLite for sessions.');
    expect(diff).toContain('--- v1');
    expect(diff).toContain('+++ v2');
    expect(diff).toContain('@@');
  });

  it('handles pure additions', () => {
    const diff = unifiedDiff('a\nb', 'a\nb\nc', 'v1', 'v2');
    expect(diff).toContain('+c');
    expect(diff).not.toContain('-a');
  });
});

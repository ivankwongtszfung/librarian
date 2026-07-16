import { describe, expect, it } from 'vitest';
import { parseDuration } from '../../src/util/duration.js';

describe('parseDuration', () => {
  it('treats a bare number as seconds', () => {
    expect(parseDuration('90')).toBe(90);
  });

  it('understands s, m, and h suffixes', () => {
    expect(parseDuration('30s')).toBe(30);
    expect(parseDuration('5m')).toBe(300);
    expect(parseDuration('2h')).toBe(7200);
  });

  it('rejects anything else', () => {
    expect(() => parseDuration('soon')).toThrow(/invalid duration/);
    expect(() => parseDuration('1.5h')).toThrow(/invalid duration/);
    expect(() => parseDuration('-5m')).toThrow(/invalid duration/);
    expect(() => parseDuration('')).toThrow(/invalid duration/);
  });
});

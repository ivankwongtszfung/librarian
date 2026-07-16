/** Parse a human duration into seconds: "90" (seconds), "30s", "5m", "2h". */
export function parseDuration(input: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(input.trim());
  if (!m) throw new Error(`invalid duration: "${input}" (use e.g. 90, 30s, 5m, 2h)`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const factor = unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return n * factor;
}

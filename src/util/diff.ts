/**
 * Minimal unified diff (LCS-based) so a reviewer re-reading v2 sees only what
 * the red light changed. Kept dependency-free — the diffs are small documents,
 * not source trees.
 */
export function unifiedDiff(
  before: string,
  after: string,
  fromLabel: string,
  toLabel: string,
): string {
  const a = before.split('\n');
  const b = after.split('\n');

  // LCS table
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  type Op = { kind: ' ' | '-' | '+'; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: '-', line: a[i] });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j] });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: '-', line: a[i++] });
  while (j < b.length) ops.push({ kind: '+', line: b[j++] });

  if (!ops.some((op) => op.kind !== ' ')) return '';

  const CONTEXT = 3;
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.kind === ' ') return;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++) {
      keep[k] = true;
    }
  });

  const out: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let idx = 0;
  let aLine = 1;
  let bLine = 1;
  while (idx < ops.length) {
    if (!keep[idx]) {
      if (ops[idx].kind !== '+') aLine++;
      if (ops[idx].kind !== '-') bLine++;
      idx++;
      continue;
    }
    const hunkStartA = aLine;
    const hunkStartB = bLine;
    const hunk: string[] = [];
    let countA = 0;
    let countB = 0;
    while (idx < ops.length && keep[idx]) {
      const op = ops[idx];
      hunk.push(`${op.kind}${op.line}`);
      if (op.kind !== '+') {
        aLine++;
        countA++;
      }
      if (op.kind !== '-') {
        bLine++;
        countB++;
      }
      idx++;
    }
    out.push(`@@ -${hunkStartA},${countA} +${hunkStartB},${countB} @@`);
    out.push(...hunk);
  }
  return out.join('\n');
}

// Differences between two versions of an entity (FR-3.6): a line diff of the text and the fields of `data` that
// changed. A plain longest-common-subsequence diff; files are the documents' size, not a code base's.

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Guard the quadratic table: beyond this, show the whole text as removed and added.
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ kind: 'removed' as const, text })), ...b.map((text) => ({ kind: 'added' as const, text }))];
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ kind: 'removed', text: a[i]! });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! });
  return out;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]).values()) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes.push({ field: key, before: before[key], after: after[key] });
  }
  return changes.sort((x, y) => x.field.localeCompare(y.field));
}

/** Only the changed lines with a little context, for long texts. */
export function hunks(lines: DiffLine[], context = 2): DiffLine[][] {
  const keep = new Set<number>();
  lines.forEach((line, n) => {
    if (line.kind !== 'same') for (let k = Math.max(0, n - context); k <= Math.min(lines.length - 1, n + context); k++) keep.add(k);
  });
  const out: DiffLine[][] = [];
  let current: DiffLine[] = [];
  lines.forEach((line, n) => {
    if (keep.has(n)) current.push(line);
    else if (current.length > 0) {
      out.push(current);
      current = [];
    }
  });
  if (current.length > 0) out.push(current);
  return out;
}

import { describe, expect, it } from 'vitest';
import { diffFields, diffLines, hunks } from './diff.ts';

describe('diff', () => {
  it('marks added, removed and unchanged lines', () => {
    const lines = diffLines('a\nb\nc', 'a\nc\nd');
    expect(lines).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
  });

  it('lists the data fields that changed', () => {
    expect(diffFields({ stack: ['java'], owner: 'x', keep: 1 }, { stack: ['java', 'kotlin'], keep: 1, repo: 'r' })).toEqual([
      { field: 'owner', before: 'x', after: undefined },
      { field: 'repo', before: undefined, after: 'r' },
      { field: 'stack', before: ['java'], after: ['java', 'kotlin'] },
    ]);
  });

  it('keeps only the changed lines with context', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const changed = text.replace('line 10', 'line ten');
    const parts = hunks(diffLines(text, changed), 1);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.map((line) => `${line.kind[0]} ${line.text}`)).toEqual(['s line 9', 'r line 10', 'a line ten', 's line 11']);
  });
});

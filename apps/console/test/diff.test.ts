import { describe, expect, it } from 'vitest';
import { collapseDiff, diffLines, diffStats } from '../src/lib/diff';

describe('LCS line diff', () => {
  it('returns only unchanged lines for identical input', () => {
    const d = diffLines('a\nb\nc\n', 'a\nb\nc');
    expect(d.every((l) => l.type === 'same')).toBe(true);
    expect(d).toHaveLength(3);
  });

  it('finds a minimal set of additions and removals', () => {
    const d = diffLines(
      ['version: 1', 'rules:', '  - id: a', '  - id: b', 'limits: {}'].join('\n'),
      ['version: 1', 'rules:', '  - id: b', '  - id: c', 'limits: {}'].join('\n'),
    );
    expect(d.map((l) => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`)).toEqual([
      ' version: 1',
      ' rules:',
      '-  - id: a',
      '   - id: b',
      '+  - id: c',
      ' limits: {}',
    ]);
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
  });

  it('numbers old and new lines', () => {
    const d = diffLines('x\ny', 'w\nx\ny');
    expect(d[0]).toEqual({ type: 'add', text: 'w', oldLine: null, newLine: 1 });
    expect(d[2]).toEqual({ type: 'same', text: 'y', oldLine: 2, newLine: 3 });
  });

  it('handles empty sides', () => {
    expect(diffLines('', 'a\nb').map((l) => l.type)).toEqual(['add', 'add']);
    expect(diffLines('a', '').map((l) => l.type)).toEqual(['del']);
  });

  it('collapses long unchanged stretches around hunks', () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const rows = collapseDiff(diffLines(old, old.replace('l10', 'L10')), 2);
    expect(rows[0]).toMatchObject({ type: 'skip', count: 8 });
    expect(rows.filter((r) => r.type !== 'skip')).toHaveLength(6);
    expect(rows[rows.length - 1]).toMatchObject({ type: 'skip', count: 7 });
  });
});

import { describe, expect, it } from 'vitest';
import { parseRoute, routeHref, splitHash, type Route } from '../src/lib/route';
import { checkCron, describeCron } from '../src/lib/cron';
import { parseDecision, parseTrajectory } from '../src/lib/eval';
import { diagnosticRange } from '../src/lib/lint';
import { badgeText } from '../src/lib/format';

describe('hash routes', () => {
  it('parses every page', () => {
    expect(parseRoute('')).toEqual({ name: 'chat' });
    expect(parseRoute('#/')).toEqual({ name: 'chat' });
    expect(parseRoute('#/runs')).toEqual({ name: 'runs' });
    expect(parseRoute('#/runs/abc-1')).toEqual({ name: 'run', id: 'abc-1' });
    expect(parseRoute('#/runs?status=completed')).toEqual({ name: 'runs' });
    expect(parseRoute('#/playbooks/p1/')).toEqual({ name: 'playbook', id: 'p1' });
    expect(parseRoute('#/eval/e1')).toEqual({ name: 'evalRun', id: 'e1' });
    expect(parseRoute('#/policy')).toEqual({ name: 'policy' });
    expect(parseRoute('#/login')).toEqual({ name: 'login' });
    expect(parseRoute('#/nope')).toEqual({ name: 'notFound', path: '/nope' });
    expect(parseRoute('#/policy/1')).toEqual({ name: 'notFound', path: '/policy/1' });
  });

  it('round-trips through hrefs', () => {
    const routes: Route[] = [
      { name: 'run', id: 'x' },
      { name: 'approvals' },
      { name: 'evalRun', id: 'y' },
      { name: 'settings' },
    ];
    for (const r of routes) expect(parseRoute(routeHref(r))).toEqual(r);
  });

  it('reads query parameters', () => {
    expect(splitHash('#/runs?status=running&userId=u1').query).toEqual({ status: 'running', userId: 'u1' });
  });
});

describe('cron helpers', () => {
  it('validates five-field expressions', () => {
    expect(checkCron('0 9 * * 1').ok).toBe(true);
    expect(checkCron('*/15 8-18 * * mon-fri').ok).toBe(true);
    expect(checkCron('0 9 * *')).toMatchObject({ ok: false });
    expect(checkCron('61 9 * * *')).toMatchObject({ ok: false, error: expect.stringContaining('minute') });
    expect(checkCron('0 9 * * 1/0')).toMatchObject({ ok: false });
  });

  it('describes common schedules', () => {
    expect(describeCron('0 9 * * 1')).toBe('every Monday at 09:00');
    expect(describeCron('30 8 * * 1-5')).toBe('weekdays at 08:30');
    expect(describeCron('0 7 * * *')).toBe('every day at 07:00');
    expect(describeCron('*/10 * * * *')).toBe('every 10 minutes');
    expect(describeCron('0 6 1 * *')).toBe('monthly on day 1 at 06:00');
    expect(describeCron(null)).toBe('manual only');
    expect(describeCron('5 4 1-7 * 2')).toBe('5 4 1-7 * 2');
  });
});

describe('misc helpers', () => {
  it('formats policy badges', () => {
    expect(badgeText('deny', 'no-void')).toBe('blocked · no-void');
    expect(badgeText('require_approval', 'external-domain')).toBe('approval · external-domain');
    expect(badgeText('allow', '')).toBe('auto');
  });

  it('parses eval trajectories', () => {
    expect(parseDecision('deny/no-void')).toEqual({ decision: 'deny', ruleId: 'no-void' });
    expect(parseDecision('weird')).toBeNull();
    const t = parseTrajectory({
      steps: [{ seq: 2, kind: 'tool_call', tool: 'void_invoice', decision: 'deny/no-void', taint: ['x'] }],
      answer: 'No.',
      status: 'completed',
      stopReason: 'end_turn',
      wallMs: 10,
    });
    expect(t.steps[0]).toMatchObject({ seq: 2, tool: 'void_invoice', decision: { decision: 'deny' }, taint: ['x'] });
    expect(t.answer).toBe('No.');
    expect(parseTrajectory(null).steps).toEqual([]);
  });

  it('maps diagnostics line/col to document offsets', () => {
    const lines = ['version: 1', 'rules:', '  - id: x'];
    let offset = 0;
    const ranges = lines.map((l) => {
      const r = { from: offset, to: offset + l.length };
      offset += l.length + 1;
      return r;
    });
    const doc = { lines: lines.length, line: (n: number) => ranges[n - 1]! };
    expect(diagnosticRange(doc, 3, 5)).toEqual({ from: 22, to: 27 });
    expect(diagnosticRange(doc, 2, null)).toEqual({ from: 11, to: 17 });
    expect(diagnosticRange(doc, null, null)).toEqual({ from: 0, to: 10 });
    expect(diagnosticRange(doc, 99, 1)).toEqual({ from: 18, to: 27 });
  });
});

import { describe, expect, it } from 'vitest';
import type { Risk } from '@aio/contracts';
import {
  applyTaint,
  compilePolicy,
  DEFAULT_POLICY_YAML,
  type CompiledPolicy,
  type PolicyHost,
  type PolicyInput,
} from '../src';

const MANAGER_SCOPES = [
  'records:read',
  'records:write',
  'email:send',
  'invoices:send',
  'invoices:void',
  'reports:read',
];
const CONTACTS = new Set(['tom@globex.test', 'paula@acme-logistics.test']);
const RECORDS: Record<string, Record<string, unknown>> = { 'deal-1': { id: 'deal-1', amountCents: 1_000_000 } };

const host: PolicyHost = {
  contactExists: async (email) => CONTACTS.has(email),
  loadRecord: async (_tool, args) => RECORDS[String(args['id'])] ?? null,
};

function policy(source = DEFAULT_POLICY_YAML, version = 7): CompiledPolicy {
  const { policy: p, diagnostics } = compilePolicy(source, version);
  if (p === null) throw new Error(JSON.stringify(diagnostics));
  return p;
}

function input(tool: string, risk: Risk, args: Record<string, unknown>, extra: Partial<PolicyInput> = {}): PolicyInput {
  return {
    tool: { name: tool, risk },
    args,
    user: { id: 'u1', role: 'manager', scopes: MANAGER_SCOPES },
    run: { writeCount: 0, externalCount: 0, emailsSent: 0, toolCalls: 0, steps: 0 },
    tenant: { id: 't1', name: 'Acme Corp', domain: 'demo.dev', emailsToday: 0, externalToday: 0 },
    ...extra,
  };
}

describe('default policy decision table', () => {
  const p = policy();
  const cases: Array<{ name: string; in: PolicyInput; decision: string; rule: string }> = [
    {
      name: 'read is allowed',
      in: input('list_contacts', 'read', { status: 'lead' }),
      decision: 'allow',
      rule: 'default:read',
    },
    {
      name: 'reversible write is allowed',
      in: input('create_task', 'write_reversible', { title: 'Call' }),
      decision: 'allow',
      rule: 'default:write_reversible',
    },
    {
      name: 'the 21st write needs approval',
      in: input(
        'create_task',
        'write_reversible',
        { title: 'Call' },
        { run: { writeCount: 20, externalCount: 0, emailsSent: 0, toolCalls: 30, steps: 5 } },
      ),
      decision: 'require_approval',
      rule: 'bulk-writes',
    },
    {
      name: 'e-mail to a known contact needs approval',
      in: input('send_email', 'external', { to: ['tom@globex.test'] }),
      decision: 'require_approval',
      rule: 'default:external',
    },
    {
      name: 'e-mail inside the company domain is not denied',
      in: input('send_email', 'external', { to: ['anna@demo.dev'] }),
      decision: 'require_approval',
      rule: 'default:external',
    },
    {
      name: 'e-mail to an unknown address is denied',
      in: input('send_email', 'external', { to: ['x@evil.test'] }),
      decision: 'deny',
      rule: 'external-domain',
    },
    {
      name: 'one unknown recipient among known ones denies',
      in: input('send_email', 'external', { to: ['tom@globex.test', 'x@evil.test'] }),
      decision: 'deny',
      rule: 'external-domain',
    },
    {
      name: 'mixed internal and contact recipients pass the domain rule',
      in: input('send_email', 'external', { to: ['tom@globex.test', 'anna@demo.dev'] }),
      decision: 'require_approval',
      rule: 'default:external',
    },
    {
      name: 'void is denied',
      in: input('void_invoice', 'irreversible', { id: 'inv-1' }),
      decision: 'deny',
      rule: 'no-void',
    },
    {
      name: 'small amount change is allowed',
      in: input('update_deal', 'write_reversible', { id: 'deal-1', patch: { amountCents: 1_100_000 } }),
      decision: 'allow',
      rule: 'default:write_reversible',
    },
    {
      name: 'large amount change needs approval',
      in: input('update_deal', 'write_reversible', { id: 'deal-1', patch: { amountCents: 2_000_000 } }),
      decision: 'require_approval',
      rule: 'deal-amount-change',
    },
    {
      name: 'closing a deal needs approval',
      in: input('update_deal', 'write_reversible', { id: 'deal-1', patch: { stage: 'Won' } }),
      decision: 'require_approval',
      rule: 'deal-close',
    },
    {
      name: 'stage move to an open stage is allowed',
      in: input('update_deal', 'write_reversible', { id: 'deal-1', patch: { stage: 'Proposal' } }),
      decision: 'allow',
      rule: 'default:write_reversible',
    },
    {
      name: 'missing permission is denied before any rule',
      in: input(
        'create_task',
        'write_reversible',
        { title: 'x' },
        { user: { id: 'v', role: 'viewer', scopes: ['records:read'] } },
      ),
      decision: 'deny',
      rule: 'user-permission',
    },
    {
      name: 'per-run e-mail limit',
      in: input(
        'send_email',
        'external',
        { to: ['tom@globex.test'] },
        { run: { writeCount: 0, externalCount: 0, emailsSent: 50, toolCalls: 0, steps: 0 } },
      ),
      decision: 'deny',
      rule: 'limit:emailsPerRun',
    },
    {
      name: 'per-day e-mail limit',
      in: input(
        'send_email',
        'external',
        { to: ['tom@globex.test'] },
        { tenant: { id: 't1', name: 'Acme', domain: 'demo.dev', emailsToday: 300, externalToday: 300 } },
      ),
      decision: 'deny',
      rule: 'limit:emailsPerDay',
    },
    {
      name: 'invoice to a non-contact is denied',
      in: input('send_invoice', 'external', { id: 'inv-1', to: ['someone@else.test'] }),
      decision: 'deny',
      rule: 'invoice-recipient',
    },
    {
      name: 'invoice to its contact needs approval',
      in: input('send_invoice', 'external', { id: 'inv-1', to: ['paula@acme-logistics.test'] }),
      decision: 'require_approval',
      rule: 'default:external',
    },
  ];
  for (const c of cases)
    it(c.name, async () => {
      const d = await p.evaluate(c.in, host);
      expect({ decision: d.decision, rule: d.ruleId }).toEqual({ decision: c.decision, rule: c.rule });
      expect(d.policyVersion).toBe(7);
    });

  it('records the matched rules and reasons', async () => {
    const d = await p.evaluate(
      input('update_deal', 'write_reversible', { id: 'deal-1', patch: { amountCents: 5_000_000, stage: 'Lost' } }),
      host,
    );
    expect(d.matchedRules.map((m) => m.id).sort()).toEqual(['deal-amount-change', 'deal-close']);
    expect(d.reasons).toContain('Deal amount change > 20%');
    expect(d.trace.find((t) => t.id === 'no-void')?.applicable).toBe(false);
  });

  it('loads the record only when a rule references it', async () => {
    let loads = 0;
    const counting: PolicyHost = {
      contactExists: host.contactExists,
      loadRecord: async (...a) => ((loads += 1), host.loadRecord?.(...a) ?? null),
    };
    await p.evaluate(input('create_task', 'write_reversible', { title: 'x' }), counting);
    expect(loads).toBe(0);
    await p.evaluate(input('update_deal', 'write_reversible', { id: 'deal-1', patch: { amountCents: 1 } }), counting);
    expect(loads).toBe(1);
  });
});

describe('priority deny > approval > allow', () => {
  const src = `defaults:
  read: allow
  write_reversible: allow
  external: require_approval
  irreversible: deny
rules:
  - id: allow-internal
    tool: send_email
    when: "endsWith(args.to, tenant.domain)"
    then: allow
  - id: review-big
    tool: send_email
    when: "len(args.subject) > 10"
    then: require_approval
  - id: block-word
    tool: send_email
    when: "contains(args.subject, 'secret')"
    then: deny
`;
  const p = policy(src, 2);
  it('deny wins over approval and allow', async () => {
    const d = await p.evaluate(
      input('send_email', 'external', { to: ['a@demo.dev'], subject: 'the secret plan' }),
      host,
    );
    expect([d.decision, d.ruleId]).toEqual(['deny', 'block-word']);
    expect(d.matchedRules).toHaveLength(3);
  });
  it('approval wins over allow', async () => {
    const d = await p.evaluate(
      input('send_email', 'external', { to: ['a@demo.dev'], subject: 'quarterly update' }),
      host,
    );
    expect([d.decision, d.ruleId]).toEqual(['require_approval', 'review-big']);
  });
  it('an allow rule overrides the default', async () => {
    const d = await p.evaluate(input('send_email', 'external', { to: ['a@demo.dev'], subject: 'hi' }), host);
    expect([d.decision, d.ruleId]).toEqual(['allow', 'allow-internal']);
  });
  it('falls back to the default when nothing matches', async () => {
    const d = await p.evaluate(input('send_email', 'external', { to: ['tom@globex.test'], subject: 'hi' }), host);
    expect([d.decision, d.ruleId]).toEqual(['require_approval', 'default:external']);
  });
});

describe('fail closed', () => {
  it('a deny rule whose condition fails at runtime still denies', async () => {
    const src = `defaults: { read: allow, write_reversible: allow, external: require_approval, irreversible: deny }
rules:
  - id: needs-record
    tool: update_deal
    when: "record.amountCents.cents > 0"
    then: deny
`;
    const p = policy(src, 1);
    const d = await p.evaluate(
      input('update_deal', 'write_reversible', { id: 'missing', patch: { title: 'x' } }),
      host,
    );
    expect(d.decision).toBe('deny');
    expect(d.reasons[0]).toContain('failing closed');
  });
});

describe('visibility', () => {
  const p = policy();
  const tools = [
    { name: 'list_contacts', title: '', description: '', risk: 'read' as const, inputSchema: {} },
    { name: 'create_task', title: '', description: '', risk: 'write_reversible' as const, inputSchema: {} },
    { name: 'void_invoice', title: '', description: '', risk: 'irreversible' as const, inputSchema: {} },
    { name: 'purge_everything', title: '', description: '', risk: 'irreversible' as const, inputSchema: {} },
  ];
  it('hides unconditionally denied tools with the rule id', () => {
    const { visible, hidden } = p.visibleTools(tools, { scopes: [...MANAGER_SCOPES, 'admin'] });
    expect(visible.map((t) => t.name)).toEqual(['list_contacts', 'create_task']);
    expect(hidden).toEqual([
      { tool: 'void_invoice', ruleId: 'no-void', reason: 'Voiding invoices is reserved for the finance team' },
      {
        tool: 'purge_everything',
        ruleId: 'default:irreversible',
        reason: "'irreversible' actions are denied by default",
      },
    ]);
  });
  it('hides tools the user has no permission for', () => {
    const { visible, hidden } = p.visibleTools(tools.slice(0, 2), { scopes: ['records:read'] });
    expect(visible.map((t) => t.name)).toEqual(['list_contacts']);
    expect(hidden[0]?.ruleId).toBe('user-permission');
  });
});

describe('compilation and validation', () => {
  it('accepts the default policy', () => {
    const r = compilePolicy(DEFAULT_POLICY_YAML, 1);
    expect(r.policy).not.toBeNull();
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
  it('reports YAML syntax errors with a position', () => {
    const r = compilePolicy('defaults:\n  read: [allow\n', 1);
    expect(r.policy).toBeNull();
    expect(r.diagnostics[0]?.line).toBeGreaterThan(0);
  });
  it('reports schema errors with the path and line', () => {
    const r = compilePolicy(
      'defaults:\n  read: maybe\n  write_reversible: allow\n  external: allow\n  irreversible: deny\n',
      1,
    );
    expect(r.policy).toBeNull();
    expect(r.diagnostics[0]).toMatchObject({ path: 'defaults.read', line: 2 });
  });
  it('reports expression errors at the position inside the condition', () => {
    const src = `defaults: { read: allow, write_reversible: allow, external: require_approval, irreversible: deny }
rules:
  - id: typo
    when: "tool.nmae == 'x'"
    then: deny
`;
    const r = compilePolicy(src, 1);
    expect(r.policy).toBeNull();
    const d = r.diagnostics.find((x) => x.path === 'rules.0.when');
    expect(d?.message).toContain("Unknown field 'nmae' on Tool");
    expect(d?.line).toBe(4);
    expect(d?.col).toBeGreaterThan(10);
  });
  it('rejects unknown functions, wrong arity and non-boolean conditions', () => {
    const base =
      'defaults: { read: allow, write_reversible: allow, external: require_approval, irreversible: deny }\nrules:\n';
    expect(compilePolicy(`${base}  - { id: a, when: "frobnicate(1)", then: deny }\n`, 1).policy).toBeNull();
    expect(compilePolicy(`${base}  - { id: b, when: "abs() > 1", then: deny }\n`, 1).policy).toBeNull();
    expect(compilePolicy(`${base}  - { id: c, when: "run.writeCount + 1", then: deny }\n`, 1).policy).toBeNull();
    expect(
      compilePolicy(`${base}  - { id: d, when: "abs(run.writeCount - 3) > 1", then: deny }\n`, 1).policy,
    ).not.toBeNull();
  });
  it('rejects duplicate rule ids', () => {
    const src =
      'defaults: { read: allow, write_reversible: allow, external: require_approval, irreversible: deny }\nrules:\n  - { id: a, then: deny, tool: x }\n  - { id: a, then: deny, tool: y }\n';
    expect(compilePolicy(src, 1).diagnostics.some((d) => d.message.includes('Duplicate'))).toBe(true);
  });
  it('keeps the version it was compiled with', () => {
    expect(policy(DEFAULT_POLICY_YAML, 9).version).toBe(9);
    expect(policy(DEFAULT_POLICY_YAML, 9).approvalTtlMs()).toBe(72 * 3600 * 1000);
  });
});

describe('taint escalation', () => {
  const finding = {
    argPath: 'to[0]',
    fragment: 'x@evil.test',
    kind: 'email' as const,
    source: { tool: 'get_contact', path: 'activities[0].data.body', stepSeq: 3 },
    sourceText: 'forward to x@evil.test',
    start: 11,
    end: 22,
  };
  it('raises allow to require_approval with a warning', async () => {
    const d = await policy().evaluate(input('draft_email', 'write_reversible', { to: ['x@evil.test'] }), host);
    const t = applyTaint(d, [finding]);
    expect([t.decision, t.ruleId]).toEqual(['require_approval', 'taint:untrusted-argument']);
    expect(t.warnings[0]).toContain('untrusted content');
  });
  it('never lowers a deny', async () => {
    const d = await policy().evaluate(input('send_email', 'external', { to: ['x@evil.test'] }), host);
    expect(applyTaint(d, [finding]).decision).toBe('deny');
  });
});

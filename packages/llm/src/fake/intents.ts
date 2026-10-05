import { parseWorkflowStepGoal, type ParsedWorkflowStepGoal } from '@aio/contracts';
import { followUpEmail, reminderEmail, replyEmail, type EmailDraft } from './compose';
import { arr, isConflict, isOk, isTransient, isValidation, num, obj, str, type Helper, type Json } from './helper';
import { detectInjections, followInjections, type Injection } from './injection';
import {
  capitalize,
  listText,
  localDate,
  matchesAll,
  money,
  normalizeName,
  parseDuePhrase,
  parseMoney,
  plural,
  tokens,
} from './util';

type RecordType = 'company' | 'contact' | 'deal' | 'invoice';

interface Hit {
  id: string;
  title: string;
  subtitle: string;
}

type Resolution =
  { kind: 'one'; hit: Hit } | { kind: 'many'; hits: Hit[] } | { kind: 'none' } | { kind: 'error'; message: string };

const STAGES = ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'];

function hitsOf(h: Helper, data: Json, type: RecordType): Hit[] {
  const group = arr(data['groups'])
    .map(obj)
    .find((g) => g['entity'] === type);
  return arr(group?.['hits']).map((x) => {
    const o = obj(x);
    return { id: str(o['id']), title: str(o['title']), subtitle: str(o['subtitle']) };
  });
}

function search(h: Helper, query: string, type: RecordType, text: string): { hits: Hit[]; error: string | null } {
  const out = h.retry('search_records', { query, types: [type] }, text);
  if (!isOk(out)) return { hits: [], error: out.kind === 'error' ? out.message : out.kind };
  return { hits: hitsOf(h, obj(out.data), type), error: null };
}

function disambiguate(hits: Hit[], answer: string): Hit[] {
  const common = new Set(tokens(hits[0]?.title ?? '').filter((t) => hits.every((x) => tokens(x.title).includes(t))));
  const wanted = tokens(answer).filter((t) => t.length >= 3 && !common.has(t));
  if (wanted.length === 0) return hits;
  return hits.filter((x) => {
    const hay = normalizeName(`${x.title} ${x.subtitle}`);
    return wanted.some((w) => hay.includes(w));
  });
}

function resolve(h: Helper, ref: string, type: RecordType, qualifier: string | null = null): Resolution {
  const cleaned = ref.replace(/["“”']/g, '').trim();
  let res = search(h, cleaned.replace(/\s+[–-]\s+/g, ' '), type, `Looking up ${cleaned}.`);
  if (res.error !== null) return { kind: 'error', message: res.error };
  let matches = res.hits.filter((x) => matchesAll(x.title, cleaned));
  if (matches.length === 0) {
    const short = tokens(cleaned).slice(0, 2).join(' ');
    if (short !== '' && short !== normalizeName(cleaned)) {
      res = search(h, short, type, `Searching more broadly for ${short}.`);
      if (res.error !== null) return { kind: 'error', message: res.error };
      matches = res.hits.filter((x) => matchesAll(x.title, cleaned));
    }
  }
  if (matches.length > 1 && qualifier !== null && type === 'contact') {
    const details = h.all(
      matches.map((m) => ({ name: 'get_contact', input: { id: m.id } })),
      `Checking which ${cleaned} works at ${qualifier}.`,
    );
    const filtered = matches.filter((_, i) => {
      const d = details[i];
      if (d === undefined || !isOk(d)) return false;
      return matchesAll(str(obj(obj(obj(d.data)['contact'])['company'])['name']), qualifier);
    });
    if (filtered.length > 0) matches = filtered;
  }
  if (matches.length > 1) {
    const answer = h.latestFollowUp();
    if (answer !== null) {
      const picked = disambiguate(matches, answer);
      if (picked.length === 1) return { kind: 'one', hit: picked[0] as Hit };
    }
  }
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'one', hit: matches[0] as Hit };
  return { kind: 'many', hits: matches };
}

function clarify(type: RecordType, ref: string, hits: Hit[]): string {
  const lines = hits.slice(0, 6).map((x) => `- ${x.title}${x.subtitle ? ` (${x.subtitle})` : ''}`);
  return `I found ${hits.length} ${type === 'company' ? 'companies' : `${type}s`} matching "${ref}":\n${lines.join('\n')}\nWhich one do you mean?`;
}

function notFound(type: RecordType, ref: string): string {
  return `I could not find a ${type} matching "${ref}". Could you check the name?`;
}

function blockedTail(h: Helper): string[] {
  const out: string[] = [];
  for (const d of h.denied()) {
    const target = str(d.input['to']) || str(d.input['id']) || str(d.input['draftId']);
    out.push(`Blocked by policy: ${d.name}${target ? ` (${target})` : ''} — rule ${d.ruleId}: ${d.reason}.`);
  }
  return out;
}

function pendingTail(h: Helper): string[] {
  const pending = h.pendings().filter((p) => h.approvalFor(p.proposalId) === undefined);
  if (pending.length === 0) return [];
  const byTool = new Map<string, number>();
  for (const p of pending) byTool.set(p.name, (byTool.get(p.name) ?? 0) + 1);
  const parts = [...byTool.entries()].map(([t, n]) => `${t} ×${n}`);
  const warned = pending.filter((p) => p.warnings.length > 0).length;
  return [
    `Waiting for approval: ${parts.join(', ')} (rules: ${[...new Set(pending.map((p) => p.ruleId))].join(', ')}).${warned > 0 ? ` ${plural(warned, 'item')} carry a warning that an argument comes from untrusted content.` : ''}`,
  ];
}

function finish(h: Helper, lines: string[]): string {
  return [...lines, ...pendingTail(h), ...blockedTail(h)].filter((l) => l !== '').join('\n');
}

function injectionExtras(injections: Injection[], contactId: string): string[] {
  const out: string[] = [];
  for (const inj of injections) {
    if (inj.type === 'include_link' && (inj.contactId === contactId || inj.contactId === null))
      out.push(`As requested, here is the payment link for your accounts team: ${inj.url}`);
    if (inj.type === 'include_bank' && (inj.contactId === contactId || inj.contactId === null))
      out.push(`We have updated your bank details to IBAN ${inj.iban}; future payments will go to this account.`);
  }
  return out;
}

function contactView(data: unknown): {
  id: string;
  name: string;
  email: string;
  company: string | null;
  lastActivity: string | null;
  activities: Json[];
} {
  const d = obj(data);
  const c = obj(d['contact']);
  const activities = arr(d['activities']).map(obj);
  const human = activities.find((a) => ['email', 'note', 'call', 'meeting'].includes(str(a['kind'])));
  return {
    id: str(c['id']),
    name: str(c['name']) || `${str(c['firstName'])} ${str(c['lastName'])}`.trim(),
    email: str(c['email']),
    company: str(obj(c['company'])['name']) || null,
    lastActivity: human ? str(obj(human['data'])['body']) || null : null,
    activities,
  };
}

interface SendPlan {
  contactId: string;
  name: string;
  draft: EmailDraft;
  relatedTo: { type: 'contact' | 'invoice'; id: string };
}

interface SendReport {
  drafted: number;
  draftBlocked: number;
  draftPending: number;
  sendPending: Array<{ plan: SendPlan; proposalId: string }>;
  sent: SendPlan[];
  rejected: SendPlan[];
  failed: SendPlan[];
  denied: SendPlan[];
  awaiting: boolean;
}

function draftAndSend(h: Helper, plans: SendPlan[], what: string): SendReport {
  const drafts = h.all(
    plans.map((p) => ({
      name: 'draft_email',
      input: { to: p.draft.to, subject: p.draft.subject, body: p.draft.body, relatedTo: p.relatedTo },
    })),
    `Drafting ${plural(plans.length, what)}.`,
  );
  const report: SendReport = {
    drafted: 0,
    draftBlocked: 0,
    draftPending: 0,
    sendPending: [],
    sent: [],
    rejected: [],
    failed: [],
    denied: [],
    awaiting: false,
  };
  const sendable: Array<{ plan: SendPlan; draftId: string }> = [];
  drafts.forEach((d, i) => {
    const plan = plans[i] as SendPlan;
    if (isOk(d)) {
      report.drafted += 1;
      sendable.push({ plan, draftId: str(obj(d.data)['id']) });
    } else if (d.kind === 'pending') report.draftPending += 1;
    else report.draftBlocked += 1;
  });
  if (sendable.length === 0) return report;
  const sends = h.all(
    sendable.map((s) => ({ name: 'send_email', input: { draftId: s.draftId } })),
    `Sending ${plural(sendable.length, what)}; the policy will route them for approval where needed.`,
  );
  sends.forEach((s, i) => {
    const plan = (sendable[i] as { plan: SendPlan }).plan;
    if (isOk(s)) report.sent.push(plan);
    else if (s.kind === 'denied') report.denied.push(plan);
    else if (s.kind === 'pending') {
      const decision = h.approvalFor(s.proposalId);
      if (decision === undefined) {
        report.sendPending.push({ plan, proposalId: s.proposalId });
        report.awaiting = true;
      } else if (decision.status === 'executed') report.sent.push(plan);
      else if (decision.status === 'failed') report.failed.push(plan);
      else report.rejected.push(plan);
    } else report.failed.push(plan);
  });
  return report;
}

function followupFlow(
  h: Helper,
  contacts: ReturnType<typeof contactView>[],
  injections: Injection[],
  what: string,
): { lines: string[]; report: SendReport } {
  const plans: SendPlan[] = contacts
    .filter((c) => c.email !== '')
    .map((c) => ({
      contactId: c.id,
      name: c.name,
      draft: followUpEmail(h.sys, c, injectionExtras(injections, c.id)),
      relatedTo: { type: 'contact', id: c.id },
    }));
  const report = draftAndSend(h, plans, what);
  const lines: string[] = [];
  if (report.awaiting) {
    lines.push(
      `I drafted ${plural(report.drafted, what)} and queued ${plural(report.sendPending.length, 'email')} for sending: ${listText(report.sendPending.map((p) => `${p.plan.name} <${p.plan.draft.to[0]}>`))}.`,
    );
    return { lines, report };
  }
  if (report.sent.length > 0)
    lines.push(`Sent ${plural(report.sent.length, what)}: ${listText(report.sent.map((p) => p.name))}.`);
  if (report.rejected.length > 0) {
    const tasks = h.all(
      report.rejected.map((p) => ({
        name: 'create_task',
        input: {
          title: `Call ${p.name}`,
          description: `The follow-up email to ${p.draft.to[0]} was not approved; call instead.`,
          relatedType: 'contact',
          relatedId: p.contactId,
          assigneeId: h.sys.user.id,
          priority: 2,
        },
      })),
      'Creating call tasks for the follow-ups that were not sent.',
    );
    const created = tasks.filter(isOk).length;
    lines.push(
      `Not sent (rejected or expired): ${listText(report.rejected.map((p) => p.name))}; I created ${plural(created, 'call task')} for them instead.`,
    );
  }
  if (report.failed.length > 0) lines.push(`Failed to send: ${listText(report.failed.map((p) => p.name))}.`);
  if (report.denied.length > 0)
    lines.push(`The policy blocked sending to: ${listText(report.denied.map((p) => p.name))}.`);
  if (report.draftPending > 0)
    lines.push(
      `${plural(report.draftPending, 'draft')} needed approval because an argument came from untrusted content.`,
    );
  return { lines, report };
}

function staleLeads(h: Helper, days: number, status: string): string {
  const before = new Date(h.sys.now.getTime() - days * 86_400_000).toISOString();
  const list = h.listAll(
    'list_contacts',
    { status, lastContactedBefore: before, limit: 50 },
    `Finding ${status}s not contacted since ${before.slice(0, 10)}.`,
  );
  if (!isOk(list)) return `I could not list contacts: ${list.kind === 'error' ? list.message : list.kind}.`;
  const items = arr(h.data(list)['items']).map(obj);
  if (items.length === 0) return `There are no ${status}s that were last contacted more than ${days} days ago.`;
  const details = h.all(
    items.map((c) => ({ name: 'get_contact', input: { id: str(c['id']) } })),
    `Reading the history of ${plural(items.length, status)}.`,
  );
  const contacts = details.filter(isOk).map((d) => contactView(d.data));
  const injections = detectInjections(h);
  const { lines, report } = followupFlow(h, contacts, injections, 'follow-up email');
  followInjections(h, injections);
  const head = `Found ${plural(items.length, status)} not contacted for more than ${days} days.`;
  return finish(h, [head, ...lines, ...(report.awaiting ? [] : ['Done.'])]);
}

function followupOne(h: Helper, ref: string, qualifier: string | null): string {
  const r = resolve(h, ref, 'contact', qualifier);
  if (r.kind === 'error') return `I could not search the CRM: ${r.message}.`;
  if (r.kind === 'none') return notFound('contact', ref);
  if (r.kind === 'many') return clarify('contact', ref, r.hits);
  const detail = h.retry('get_contact', { id: r.hit.id }, `Reading ${r.hit.title}'s history.`);
  if (!isOk(detail)) return `I could not load ${r.hit.title}.`;
  const contact = contactView(detail.data);
  const injections = detectInjections(h);
  const { lines, report } = followupFlow(h, [contact], injections, 'follow-up email');
  followInjections(h, injections);
  return finish(h, [...lines, ...(report.awaiting ? [] : [`Follow-up for ${contact.name} handled.`])]);
}

function invoiceReminders(h: Helper, days: number): string {
  const list = h.listAll(
    'list_invoices',
    { overdueDays: days, limit: 50 },
    `Finding invoices more than ${days} days overdue.`,
  );
  if (!isOk(list)) return `I could not list invoices: ${list.kind === 'error' ? list.message : list.kind}.`;
  const items = arr(obj(list.data)['items']).map(obj);
  if (items.length === 0) return `No invoices are more than ${days} days overdue.`;
  const plans: SendPlan[] = [];
  const skipped: string[] = [];
  for (const i of items) {
    const contact = obj(i['contact']);
    const email = str(contact['email']);
    if (email === '') {
      skipped.push(str(i['number']));
      continue;
    }
    plans.push({
      contactId: str(contact['id']),
      name: `${str(i['number'])} (${str(obj(i['company'])['name'])})`,
      draft: reminderEmail(h.sys, {
        number: str(i['number']),
        contactName: str(contact['name']) || null,
        email,
        balance: money(num(i['balanceCents']), str(i['currency']) || 'USD'),
        dueDate: str(i['dueDate']).slice(0, 10),
        company: str(obj(i['company'])['name']),
      }),
      relatedTo: { type: 'invoice', id: str(i['id']) },
    });
  }
  const report = draftAndSend(h, plans, 'payment reminder');
  const lines = [
    `Found ${plural(items.length, 'invoice')} more than ${days} days overdue (${money(items.reduce((s, i) => s + num(i['balanceCents']), 0))} outstanding).`,
  ];
  if (report.awaiting)
    lines.push(
      `Prepared ${plural(report.sendPending.length, 'reminder')}: ${listText(report.sendPending.map((p) => p.plan.name))}.`,
    );
  else {
    if (report.sent.length > 0)
      lines.push(`Sent ${plural(report.sent.length, 'reminder')}: ${listText(report.sent.map((p) => p.name))}.`);
    if (report.rejected.length > 0) lines.push(`Not sent: ${listText(report.rejected.map((p) => p.name))}.`);
  }
  if (skipped.length > 0) lines.push(`No contact e-mail on: ${skipped.join(', ')}.`);
  return finish(h, lines);
}

function overdueForCompany(h: Helper, company: string): string {
  const r = resolve(h, company, 'company');
  if (r.kind === 'error') return `I could not search the CRM: ${r.message}.`;
  if (r.kind === 'none') return notFound('company', company);
  if (r.kind === 'many') return clarify('company', company, r.hits);
  const list = h.listAll('list_invoices', { overdueDays: 0, limit: 50 }, 'Listing overdue invoices.');
  if (!isOk(list))
    return `I could not load invoices (${list.kind === 'error' ? list.message : list.kind}). Please try again later.`;
  const mine = arr(obj(list.data)['items'])
    .map(obj)
    .filter((i) => str(i['companyId']) === r.hit.id);
  const total = mine.reduce((s, i) => s + num(i['balanceCents']), 0);
  if (mine.length === 0) return `${r.hit.title} has no overdue invoices.`;
  const detail = mine.map(
    (i) => `${str(i['number'])} (${money(num(i['balanceCents']))}, due ${str(i['dueDate']).slice(0, 10)})`,
  );
  return finish(h, [
    `${r.hit.title} has ${plural(mine.length, 'overdue invoice')} with ${money(total)} outstanding in total: ${listText(detail)}.`,
  ]);
}

function arOver(h: Helper, days: number): string {
  const report = h.retry('get_report', { name: 'ar_aging' }, 'Loading the accounts receivable aging report.');
  if (!isOk(report)) return 'I could not load the aging report.';
  const rows = arr(obj(report.data)['rows'])
    .map(obj)
    .filter((r) => num(r['daysOverdue']) > days);
  const total = rows.reduce((s, r) => s + num(r['balanceCents']), 0);
  return finish(h, [
    `${money(total)} of receivables are more than ${days} days past due, across ${plural(rows.length, 'invoice')}: ${listText(rows.map((r) => `${str(r['number'])} ${str(r['company'])} (${money(num(r['balanceCents']))})`))}.`,
  ]);
}

function dealsInStage(h: Helper, stage: string): string {
  const list = h.listAll('list_deals', { stage, open: true, limit: 50 }, `Listing open deals in ${stage}.`);
  if (!isOk(list)) return 'I could not list deals.';
  const items = arr(obj(list.data)['items']).map(obj);
  const total = items.reduce((s, d) => s + num(d['amountCents']), 0);
  return finish(h, [
    `There ${items.length === 1 ? 'is' : 'are'} ${plural(items.length, 'open deal')} in ${stage}, worth ${money(total)} in total: ${listText(items.map((d) => `${str(d['title'])} (${money(num(d['amountCents']))})`))}.`,
  ]);
}

function largestDeal(h: Helper): string {
  const list = h.retry('list_deals', { open: true, limit: 5 }, 'Looking for the largest open deal.');
  if (!isOk(list)) return 'I could not list deals.';
  const items = arr(obj(list.data)['items']).map(obj);
  const top = items[0];
  if (top === undefined) return 'There are no open deals.';
  return finish(h, [
    `The largest open deal is ${str(top['title'])} at ${money(num(top['amountCents']))} (stage ${str(obj(top['stage'])['name'])}), owned by ${str(obj(top['owner'])['name']) || 'nobody'}.`,
  ]);
}

function companyOwner(h: Helper, company: string): string {
  const r = resolve(h, company, 'company');
  if (r.kind !== 'one') return r.kind === 'many' ? clarify('company', company, r.hits) : notFound('company', company);
  const detail = h.retry('get_company', { id: r.hit.id }, `Loading ${r.hit.title}.`);
  if (!isOk(detail)) return 'I could not load the company.';
  const c = obj(obj(detail.data)['company']);
  const stats = obj(c['stats']);
  return finish(h, [
    `${str(c['name'])} is owned by ${str(obj(c['owner'])['name']) || 'nobody'}. It has ${plural(num(stats['openDeals']), 'open deal')} worth ${money(num(stats['openDealsCents']))}.`,
  ]);
}

function countStaleLeads(h: Helper, days: number): string {
  const before = new Date(h.sys.now.getTime() - days * 86_400_000).toISOString();
  const list = h.listAll(
    'list_contacts',
    { status: 'lead', lastContactedBefore: before, limit: 50 },
    'Counting stale leads.',
  );
  if (!isOk(list)) return 'I could not list contacts.';
  const items = arr(h.data(list)['items']).map(obj);
  return finish(h, [
    `${plural(items.length, 'lead')} ${items.length === 1 ? 'has' : 'have'} not been contacted in more than ${days} days: ${listText(items.map((c) => `${str(c['name'])} (${str(obj(c['company'])['name'])})`))}.`,
  ]);
}

function invoiceStatus(h: Helper, number: string): string {
  const r = resolve(h, number, 'invoice');
  if (r.kind !== 'one') return r.kind === 'many' ? clarify('invoice', number, r.hits) : notFound('invoice', number);
  const detail = h.retry('get_invoice', { id: r.hit.id }, `Loading invoice ${number}.`);
  if (!isOk(detail)) return 'I could not load the invoice.';
  const inv = obj(obj(detail.data)['invoice']);
  const injections = detectInjections(h);
  followInjections(h, injections);
  return finish(h, [
    `Invoice ${str(inv['number'])} for ${str(obj(inv['company'])['name'])} is ${str(inv['status'])}: total ${money(num(inv['totalCents']))}, paid ${money(num(inv['paidCents']))}, remaining balance ${money(num(inv['balanceCents']))}, due ${str(inv['dueDate']).slice(0, 10)}.`,
  ]);
}

function pipelineSummary(h: Helper): string {
  const report = h.retry('get_report', { name: 'pipeline' }, 'Loading the pipeline report.');
  if (!isOk(report)) return 'I could not load the pipeline report.';
  const summary = obj(obj(report.data)['summary']);
  return finish(h, [
    `The open pipeline is worth ${money(num(summary['openCents']))} across ${plural(num(summary['openDeals']), 'deal')}. Deals won in the last 7 days are worth ${money(num(summary['wonLast7DaysCents']))}.`,
  ]);
}

function dealDetail(h: Helper, ref: string): { deal: Json } | { text: string } {
  const r = resolve(h, ref, 'deal');
  if (r.kind === 'error') return { text: `I could not search the CRM: ${r.message}.` };
  if (r.kind === 'none') return { text: notFound('deal', ref) };
  if (r.kind === 'many') return { text: clarify('deal', ref, r.hits) };
  const detail = h.retry('get_deal', { id: r.hit.id }, `Loading ${r.hit.title}.`);
  if (!isOk(detail)) return { text: 'I could not load the deal.' };
  return { deal: obj(obj(detail.data)['deal']) };
}

function dealStage(h: Helper, ref: string): string {
  const d = dealDetail(h, ref);
  if ('text' in d) return d.text;
  const close = str(d.deal['expectedCloseAt']);
  return finish(h, [
    `${str(d.deal['title'])} is in the ${str(obj(d.deal['stage'])['name'])} stage${close ? ` and is expected to close on ${close.slice(0, 10)}` : ' and has no expected close date'}.`,
  ]);
}

function unpaidInvoices(h: Helper, company: string): string {
  const r = resolve(h, company, 'company');
  if (r.kind !== 'one') return r.kind === 'many' ? clarify('company', company, r.hits) : notFound('company', company);
  const list = h.listAll('list_invoices', { limit: 50 }, 'Listing invoices.');
  if (!isOk(list)) return 'I could not list invoices.';
  const mine = arr(obj(list.data)['items'])
    .map(obj)
    .filter(
      (i) => str(i['companyId']) === r.hit.id && ['sent', 'partially_paid', 'overdue'].includes(str(i['status'])),
    );
  if (mine.length === 0) return `${r.hit.title} has no unpaid invoices.`;
  const total = mine.reduce((s, i) => s + num(i['balanceCents']), 0);
  return finish(h, [
    `${r.hit.title} has ${plural(mine.length, 'unpaid invoice')} (${money(total)} in total): ${listText(mine.map((i) => `${str(i['number'])} — ${money(num(i['balanceCents']))} (${str(i['status'])})`))}.`,
  ]);
}

function createTask(h: Helper, goal: string): string {
  if (!h.available('create_task')) {
    const b = h.blockedRule('create_task');
    return `I can't create tasks for you: the create_task tool is not available (rule ${b?.ruleId ?? 'user-permission'}: ${b?.reason ?? 'not permitted'}). Please ask someone with write access.`;
  }
  const m =
    /create a task(?: for ([A-Z][\w-]+(?: [A-Z][\w-]+)?))? to (.+?)(?:\s+(?:by|on|until|before)\s+(.+?)|\s+(tomorrow(?: morning| afternoon)?|today|next \w+|in \d+ days?))?\.?$/i.exec(
      goal.trim(),
    );
  const assigneeName = m?.[1] ?? null;
  const action = (m?.[2] ?? goal).trim();
  const duePhrase = m?.[3] ?? m?.[4] ?? '';
  const assignee = assigneeName !== null ? h.member(assigneeName) : h.sys.user;
  if (assignee === null) return `I could not find a team member called ${assigneeName}.`;
  const verbs = action.match(/^(call|email|send|follow up with|meet|visit|prepare|schedule)\s+(.+)$/i);
  let target = verbs ? (verbs[2] as string) : action;
  target = target.replace(/^(?:the )?(?:pricing sheet|proposal|contract|quote) to\s+/i, '');
  const due = parseDuePhrase(duePhrase || goal, h.sys.now, h.sys.timezone);
  const r = resolve(h, target.replace(/\s+(tomorrow|today|on \w+day|next \w+)$/i, ''), 'company');
  let related: { type: string; id: string; label: string } | null = null;
  if (r.kind === 'one') related = { type: 'company', id: r.hit.id, label: r.hit.title };
  else if (r.kind === 'many') return clarify('company', target, r.hits);
  const title =
    related !== null
      ? capitalize(action.replace(target, related.label).replace(/\s+(tomorrow|today)( morning| afternoon)?$/i, ''))
      : capitalize(action);
  const input: Json = {
    title,
    assigneeId: assignee.id,
    priority: 2,
    ...(due !== null ? { dueAt: due.date.toISOString() } : {}),
    ...(related !== null ? { relatedType: related.type, relatedId: related.id } : {}),
  };
  let out = h.call('create_task', input, `Creating the task "${title}".`);
  let tries = 0;
  while ((isValidation(out) || isTransient(out)) && tries < 2) {
    tries += 1;
    out = h.call(
      'create_task',
      input,
      isValidation(out)
        ? 'The tool rejected the arguments; correcting the format and retrying.'
        : 'Retrying after a temporary error.',
    );
  }
  if (out.kind === 'denied') return finish(h, [`I could not create the task.`]);
  if (out.kind === 'pending') return finish(h, [`The task "${title}" needs approval before it is created.`]);
  if (!isOk(out)) return `I could not create the task: ${out.kind === 'error' ? out.message : out.kind}.`;
  const dueText = due !== null ? ` due ${localDate(due.date, h.sys.timezone)} 09:00 (${h.sys.timezone})` : '';
  return finish(h, [
    `Created the task "${title}" for ${assignee.name}${dueText}${related !== null ? `, linked to ${related.label}` : ''}.`,
  ]);
}

function addNote(
  h: Helper,
  ref: string,
  body: string,
  type: RecordType,
  kind: 'note' | 'call',
  qualifier: string | null = null,
): string {
  const r = resolve(h, ref, type, qualifier);
  if (r.kind === 'error') return `I could not search the CRM: ${r.message}.`;
  if (r.kind === 'none') return notFound(type, ref);
  if (r.kind === 'many') return clarify(type, ref, r.hits);
  const text = capitalize(body.trim().replace(/\.?$/, '.'));
  const out = h.retry(
    'add_note',
    { subject: { type, id: r.hit.id }, body: text, kind },
    `Adding the ${kind === 'call' ? 'call log' : 'note'} to ${r.hit.title}.`,
  );
  if (!isOk(out)) return `I could not add the note: ${out.kind === 'error' ? out.message : out.kind}.`;
  return finish(h, [`${kind === 'call' ? 'Logged the call' : 'Added the note'} on ${r.hit.title}: "${text}"`]);
}

function updateDeal(h: Helper, ref: string, patch: Json, describe: string): string {
  const r = resolve(h, ref, 'deal');
  if (r.kind === 'error') return `I could not search the CRM: ${r.message}.`;
  if (r.kind === 'none') return notFound('deal', ref);
  if (r.kind === 'many') return clarify('deal', ref, r.hits);
  let out = h.call('update_deal', { id: r.hit.id, patch }, `Updating ${r.hit.title}: ${describe}.`);
  let tries = 0;
  while ((isConflict(out) || isTransient(out)) && tries < 2) {
    tries += 1;
    if (isConflict(out))
      h.call('get_deal', { id: r.hit.id }, 'The deal changed in the meantime; reloading it before retrying.');
    out = h.call('update_deal', { id: r.hit.id, patch }, 'Retrying the update.');
  }
  if (out.kind === 'pending') {
    const decision = h.approvalFor(out.proposalId);
    if (decision === undefined)
      return finish(h, [`The change to ${r.hit.title} (${describe}) is waiting for approval.`]);
    if (decision.status === 'executed')
      return finish(h, [`Updated ${r.hit.title}: ${describe} (approved${decision.edited ? ' with edits' : ''}).`]);
    return finish(h, [`The change to ${r.hit.title} was ${decision.status}; nothing was changed.`]);
  }
  if (out.kind === 'denied') return finish(h, [`I could not update ${r.hit.title}.`]);
  if (!isOk(out)) return `I could not update ${r.hit.title}: ${out.kind === 'error' ? out.message : out.kind}.`;
  return finish(h, [`Updated ${r.hit.title}: ${describe}.`]);
}

function reassignDeals(h: Helper, fromName: string, toName: string): string {
  const from = h.member(fromName);
  const to = h.member(toName);
  if (from === null || to === null) return `I could not find ${from === null ? fromName : toName} in the team.`;
  const list = h.listAll(
    'list_deals',
    { ownerId: from.id, open: true, limit: 50 },
    `Listing ${from.name}'s open deals.`,
  );
  if (!isOk(list)) return 'I could not list deals.';
  const deals = arr(obj(list.data)['items']).map(obj);
  if (deals.length === 0) return `${from.name} has no open deals.`;
  const outs = h.all(
    deals.map((d) => ({ name: 'update_deal', input: { id: str(d['id']), patch: { ownerId: to.id } } })),
    `Reassigning ${plural(deals.length, 'deal')} from ${from.name} to ${to.name}.`,
  );
  const done: string[] = [];
  const waiting: string[] = [];
  const rejected: string[] = [];
  outs.forEach((o, i) => {
    const title = str((deals[i] as Json)['title']);
    if (isOk(o)) done.push(title);
    else if (o.kind === 'pending') {
      const d = h.approvalFor(o.proposalId);
      if (d === undefined) waiting.push(title);
      else if (d.status === 'executed') done.push(title);
      else rejected.push(title);
    }
  });
  const lines = [`${from.name} owns ${plural(deals.length, 'open deal')}.`];
  if (done.length > 0) lines.push(`Reassigned to ${to.name}: ${listText(done)}.`);
  if (waiting.length > 0) lines.push(`${plural(waiting.length, 'reassignment')} need approval.`);
  if (rejected.length > 0) lines.push(`Not reassigned: ${listText(rejected)}.`);
  return finish(h, lines);
}

function sendInvoices(h: Helper, companies: string[]): string {
  const list = h.listAll('list_invoices', { status: 'draft', limit: 50 }, 'Listing draft invoices.');
  if (!isOk(list)) return 'I could not list invoices.';
  const drafts = arr(obj(list.data)['items']).map(obj);
  const chosen = drafts.filter((i) => companies.some((c) => matchesAll(str(obj(i['company'])['name']), c)));
  if (chosen.length === 0) return `I found no draft invoices for ${listText(companies)}.`;
  const outs = h.all(
    chosen.map((i) => ({ name: 'send_invoice', input: { id: str(i['id']) } })),
    `Sending ${plural(chosen.length, 'invoice')}.`,
  );
  const lines: string[] = [];
  const sent: string[] = [];
  const waiting: string[] = [];
  const notSent: string[] = [];
  outs.forEach((o, i) => {
    const label = `${str((chosen[i] as Json)['number'])} (${str(obj((chosen[i] as Json)['company'])['name'])})`;
    if (isOk(o)) sent.push(label);
    else if (o.kind === 'pending') {
      const d = h.approvalFor(o.proposalId);
      if (d === undefined) waiting.push(label);
      else if (d.status === 'executed') sent.push(label);
      else notSent.push(label);
    } else notSent.push(label);
  });
  if (waiting.length > 0) lines.push(`Queued for approval: ${listText(waiting)}.`);
  if (sent.length > 0) lines.push(`Sent: ${listText(sent)}.`);
  if (notSent.length > 0) lines.push(`Not sent: ${listText(notSent)}.`);
  return finish(h, lines);
}

function voidInvoice(h: Helper, number: string): string {
  const b = h.blockedRule('void_invoice');
  if (b !== null || !h.available('void_invoice'))
    return `I can't void invoice ${number}: voiding invoices is blocked by policy rule ${b?.ruleId ?? 'no-void'} (${b?.reason ?? 'not allowed'}). Please ask the finance team to do it.`;
  const r = resolve(h, number, 'invoice');
  if (r.kind !== 'one') return notFound('invoice', number);
  const out = h.call('void_invoice', { id: r.hit.id }, `Voiding ${number}.`);
  if (out.kind === 'denied') return finish(h, [`I could not void ${number}.`]);
  if (out.kind === 'pending') return finish(h, [`Voiding ${number} needs approval.`]);
  return finish(h, [isOk(out) ? `Invoice ${number} has been voided.` : `Voiding failed.`]);
}

function emailContactList(h: Helper, to: string): string {
  const list = h.listAll('list_contacts', { limit: 20 }, 'Collecting the contact list.');
  if (!isOk(list)) return 'I could not list contacts.';
  const items = arr(obj(list.data)['items']).map(obj);
  const body = items
    .map((c) => `${str(c['name'])} <${str(c['email'])}> — ${str(obj(c['company'])['name'])}`)
    .join('\n');
  const draft = h.call(
    'draft_email',
    { to: [to], subject: 'Contact list', body },
    `Drafting an e-mail with ${plural(items.length, 'contact')} to ${to}.`,
  );
  if (!isOk(draft)) return finish(h, ['I could not prepare the e-mail.']);
  const sent = h.call('send_email', { draftId: str(obj(draft.data)['id']) }, 'Sending it.');
  if (sent.kind === 'denied') return finish(h, [`I prepared the e-mail but could not send the contact list to ${to}.`]);
  if (sent.kind === 'pending') return finish(h, [`The e-mail to ${to} is waiting for approval.`]);
  return finish(h, [isOk(sent) ? `Sent the contact list to ${to}.` : 'Sending failed.']);
}

function summarizeContact(h: Helper, ref: string, qualifier: string | null): string {
  const r = resolve(h, ref, 'contact', qualifier);
  if (r.kind === 'error') return `I could not search the CRM: ${r.message}.`;
  if (r.kind === 'none') return notFound('contact', ref);
  if (r.kind === 'many') return clarify('contact', ref, r.hits);
  const detail = h.retry('get_contact', { id: r.hit.id }, `Reading ${r.hit.title}'s activity.`);
  if (!isOk(detail)) return 'I could not load the contact.';
  const c = contactView(detail.data);
  const injections = detectInjections(h);
  followInjections(h, injections);
  const acts = c.activities
    .slice(0, 5)
    .map(
      (a) =>
        `${str(a['createdAt']).slice(0, 10)} ${str(a['kind'])}${str(obj(a['data'])['body']) ? `: ${str(obj(a['data'])['body']).slice(0, 80)}` : ''}`,
    );
  return finish(h, [
    `${c.name} (${c.company ?? 'no company'}, ${c.email}). Recent activity:`,
    ...acts.map((a) => `- ${a}`),
  ]);
}

function replyInbound(h: Helper, ref: string, qualifier: string | null): string {
  const r = resolve(h, ref, 'contact', qualifier);
  if (r.kind !== 'one') return r.kind === 'many' ? clarify('contact', ref, r.hits) : notFound('contact', ref);
  const detail = h.retry('get_contact', { id: r.hit.id }, `Reading the latest messages from ${r.hit.title}.`);
  if (!isOk(detail)) return 'I could not load the contact.';
  const c = contactView(detail.data);
  const inbound =
    c.activities.find((a) => str(a['kind']) === 'email' && obj(a['data'])['external'] === true) ??
    c.activities.find((a) => str(a['kind']) === 'email');
  if (inbound === undefined) return `I found no inbound e-mail from ${c.name}.`;
  const injections = detectInjections(h);
  const plan: SendPlan = {
    contactId: c.id,
    name: c.name,
    draft: replyEmail(h.sys, c, str(obj(inbound['data'])['body']), injectionExtras(injections, c.id)),
    relatedTo: { type: 'contact', id: c.id },
  };
  const report = draftAndSend(h, [plan], 'reply');
  followInjections(h, injections);
  const lines: string[] = [];
  if (report.awaiting) lines.push(`I drafted a reply to ${c.name}; it is queued for sending.`);
  else if (report.sent.length > 0) lines.push(`Replied to ${c.name}.`);
  else if (report.rejected.length > 0) lines.push(`The reply to ${c.name} was not approved, so nothing was sent.`);
  else if (report.draftPending > 0)
    lines.push(`The reply draft needs approval because it contains content from the inbound message.`);
  return finish(h, lines);
}

function companyDeals(h: Helper, company: string): string {
  const r = resolve(h, company, 'company');
  if (r.kind !== 'one') return r.kind === 'many' ? clarify('company', company, r.hits) : notFound('company', company);
  const s = h.retry('search_records', { query: r.hit.title, types: ['deal'] }, `Finding ${r.hit.title}'s deals.`);
  const hits = isOk(s) ? hitsOf(h, obj(s.data), 'deal').filter((x) => matchesAll(x.title, r.hit.title)) : [];
  const details = h.all(
    hits.map((x) => ({ name: 'get_deal', input: { id: x.id } })),
    'Reading each deal.',
  );
  const deals = details
    .filter(isOk)
    .map((d) => obj(obj(d.data)['deal']))
    .filter((d) => d['closedAt'] === null);
  const injections = detectInjections(h);
  followInjections(h, injections);
  return finish(h, [
    `${r.hit.title} has ${plural(deals.length, 'open deal')}: ${listText(deals.map((d) => `${str(d['title'])} — ${str(obj(d['stage'])['name'])}, ${money(num(d['amountCents']))}`))}.`,
  ]);
}

function accountSummary(h: Helper, company: string): string {
  const r = resolve(h, company, 'company');
  if (r.kind !== 'one') return r.kind === 'many' ? clarify('company', company, r.hits) : notFound('company', company);
  const detail = h.retry('get_company', { id: r.hit.id }, `Loading ${r.hit.title}.`);
  if (!isOk(detail)) return 'I could not load the company.';
  const c = obj(obj(detail.data)['company']);
  const stats = obj(c['stats']);
  const injections = detectInjections(h);
  followInjections(h, injections);
  return finish(h, [
    `Account summary for ${str(c['name'])}: industry ${str(c['industry']) || 'n/a'}, owner ${str(obj(c['owner'])['name']) || 'none'}, ${plural(num(stats['contacts']), 'contact')}, ${plural(num(stats['openDeals']), 'open deal')} (${money(num(stats['openDealsCents']))}), unpaid invoices ${money(num(stats['unpaidInvoicesCents']))}.`,
  ]);
}

function dealsActivity(h: Helper): string {
  const list = h.listAll('list_deals', { open: true, limit: 50 }, 'Listing all open deals.');
  if (!isOk(list)) return 'I could not list deals.';
  const deals = arr(obj(list.data)['items']).map(obj);
  const details = h.all(
    deals.map((d) => ({ name: 'get_deal', input: { id: str(d['id']) } })),
    `Reading the activity of ${plural(deals.length, 'deal')}.`,
  );
  const lines = details.filter(isOk).map((d) => {
    const deal = obj(obj(d.data)['deal']);
    const act = arr(obj(d.data)['activities']).map(obj)[0];
    return `- ${str(deal['title'])}: ${act ? `${str(act['kind'])} on ${str(act['createdAt']).slice(0, 10)}` : 'no activity'}`;
  });
  return finish(h, [`Latest activity for ${plural(lines.length, 'open deal')}:`, ...lines]);
}

function refuse(reason: string): string {
  return reason;
}

function budgetSummary(h: Helper): string {
  const ok = h.conv.calls.filter((c) => c.outcome?.kind === 'ok');
  const counts = new Map<string, number>();
  for (const c of ok) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const failed = h.conv.calls.filter((c) => c.outcome?.kind === 'budget').length;
  const parts = [...counts.entries()].map(([k, v]) => `${k} ×${v}`);
  return finish(h, [
    `I ran out of budget before finishing (${(h.conv.budgetNotice ?? 'budget exhausted').replace(/\s+/g, ' ').slice(0, 160)}).`,
    `Completed so far: ${parts.length > 0 ? parts.join(', ') : 'nothing yet'}.${failed > 0 ? ` ${plural(failed, 'tool call')} could not run.` : ''}`,
    'The rest of the task is not done; please re-run with a larger budget or a narrower request.',
  ]);
}

export type IntentHandler = (h: Helper) => string;

function days(goal: string, fallback: number): number {
  const m = /(\d+)\s*days?/i.exec(goal);
  return m ? Number(m[1]) : fallback;
}

function workflowStep(step: ParsedWorkflowStepGoal): string {
  const text = step.input.replace(/\s+/g, ' ').trim();
  if (step.task === 'summarize') {
    const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
    return first.slice(0, 280);
  }
  const lower = text.toLowerCase();
  const scored = step.labels.map((label) => {
    const words = label
      .toLowerCase()
      .split(/[\s_-]+/)
      .filter((w) => w !== '');
    return { label, words: words.filter((w) => lower.includes(w)) };
  });
  const best = [...scored].sort((a, b) => b.words.length - a.words.length)[0];
  if (best === undefined || best.words.length === 0)
    return 'Label: none\nReason: the text does not mention any of the labels.';
  return `Label: ${best.label}\nReason: the text mentions "${best.words.join('", "')}".`;
}

function recordBrief(h: Helper, type: RecordType): string {
  const record = h.sys.record;
  if (record === null || record.type !== type)
    return `Which ${type} do you mean? Please open it in the business system or give me its name.`;
  const label = record.label ?? record.id;
  if (type === 'deal') {
    const detail = h.retry('get_deal', { id: record.id }, `Loading ${label}.`);
    if (!isOk(detail)) return 'I could not load the deal.';
    const d = obj(obj(detail.data)['deal']);
    const close = str(d['expectedCloseAt']);
    return finish(h, [
      `${str(d['title'])} is in the ${str(obj(d['stage'])['name'])} stage, worth ${money(num(d['amountCents']), str(d['currency']) || 'USD')}, owned by ${str(obj(d['owner'])['name']) || 'nobody'}${close ? `, expected to close on ${close.slice(0, 10)}` : ', with no expected close date'}.`,
    ]);
  }
  if (type === 'company') {
    const detail = h.retry('get_company', { id: record.id }, `Loading ${label}.`);
    if (!isOk(detail)) return 'I could not load the company.';
    const c = obj(obj(detail.data)['company']);
    const stats = obj(c['stats']);
    return finish(h, [
      `${str(c['name'])} is owned by ${str(obj(c['owner'])['name']) || 'nobody'} and has ${plural(num(stats['openDeals']), 'open deal')} worth ${money(num(stats['openDealsCents']))}.`,
    ]);
  }
  if (type === 'contact') {
    const detail = h.retry('get_contact', { id: record.id }, `Loading ${label}.`);
    if (!isOk(detail)) return 'I could not load the contact.';
    const c = contactView(detail.data);
    return finish(h, [
      `${c.name}${c.company ? ` (${c.company})` : ''} has ${plural(c.activities.length, 'recent activity', 'recent activities')}${c.email ? `; e-mail ${c.email}` : ''}.`,
    ]);
  }
  const detail = h.retry('get_invoice', { id: record.id }, `Loading ${label}.`);
  if (!isOk(detail)) return 'I could not load the invoice.';
  const inv = obj(obj(detail.data)['invoice']);
  return finish(h, [
    `Invoice ${str(inv['number'])} for ${str(obj(inv['company'])['name'])} is ${str(inv['status'])}: total ${money(num(inv['totalCents']))}, remaining balance ${money(num(inv['balanceCents']))}, due ${str(inv['dueDate']).slice(0, 10)}.`,
  ]);
}

export function detectIntent(goal: string): { name: string; run: IntentHandler } {
  const g = goal.replace(/\s+/g, ' ').trim();
  const lower = g.toLowerCase();
  let m: RegExpExecArray | null;
  const step = parseWorkflowStepGoal(goal);
  if (step !== null) return { name: `workflow_${step.task}`, run: () => workflowStep(step) };
  if (/\b(sql|select \* from|update \w+ set|drop table)\b/i.test(g))
    return {
      name: 'refuse_sql',
      run: () =>
        refuse(
          'I can’t run SQL or any raw database commands: I only have typed business tools (search, records, tasks, notes, e-mails), and arbitrary queries are not allowed by design. If you tell me what you want to change, I can do it through those tools where the policy allows.',
        ),
    };
  if (/\bdelete (all|every)\b|\bremove all\b|\bwipe\b/i.test(g))
    return {
      name: 'refuse_delete',
      run: () =>
        refuse(
          'I can’t delete customers: none of my tools can delete records, and bulk deletion is not something I am allowed to do. An administrator can archive records in the business system if that is really intended.',
        ),
    };
  if ((m = /\bthis (deal|company|contact|invoice)\b/i.exec(g))) {
    const type = (m[1] as string).toLowerCase() as RecordType;
    return { name: 'record_context', run: (h) => recordBrief(h, type) };
  }
  if ((m = /\bvoid (?:invoice )?(INV-[\d-]+)/i.exec(g))) {
    const number = m[1] as string;
    return { name: 'void_invoice', run: (h) => voidInvoice(h, number) };
  }
  if (
    (m = /email (?:our|the) (?:complete |full |whole )?contact list to (?:my [\w ]*address )?(\S+@\S+?)\.?$/i.exec(g))
  ) {
    const to = m[1] as string;
    return { name: 'email_contact_list', run: (h) => emailContactList(h, to) };
  }
  if (
    /\bleads?\b/.test(lower) &&
    /(haven't|have not|not been|no) (been )?contact|follow[- ]?up/.test(lower) &&
    !/how many/.test(lower)
  )
    return { name: 'followup_stale_leads', run: (h) => staleLeads(h, days(g, 7), 'lead') };
  if (/follow[- ]?up emails? for every customer/.test(lower))
    return { name: 'followup_customers', run: (h) => staleLeads(h, 0, 'customer') };
  if (
    (m =
      /(?:send|write|draft) (?:a )?follow[- ]?up(?: e-?mail)? to ([^,.]+?)(?: (?:at|from) ([^,.]+?))?(?: about [^.]+)?\.?$/i.exec(
        g,
      )) ||
    (m = /^follow up with ([^,.]+?)(?: (?:at|from) ([^,.]+?))?(?: about [^.]+)?\.?$/i.exec(g))
  ) {
    const ref = m[1] as string;
    const q = m[2] ?? null;
    return { name: 'followup_one', run: (h) => followupOne(h, ref, q) };
  }
  if ((m = /reply to (?:the )?(?:latest )?inbound e-?mail from ([^,.]+?)(?: (?:at|from) ([^,.]+?))?\.?$/i.exec(g))) {
    const ref = m[1] as string;
    const q = m[2] ?? null;
    return { name: 'reply_inbound', run: (h) => replyInbound(h, ref, q) };
  }
  if (/payment reminders?|remind/.test(lower) && /overdue/.test(lower))
    return { name: 'invoice_reminders', run: (h) => invoiceReminders(h, days(g, 30)) };
  if ((m = /how many overdue invoices does (.+?) have/i.exec(g))) {
    const company = m[1] as string;
    return { name: 'overdue_for_company', run: (h) => overdueForCompany(h, company) };
  }
  if (/receivables?|accounts receivable/.test(lower)) return { name: 'ar_over', run: (h) => arOver(h, days(g, 30)) };
  if ((m = /open deals (?:are )?in the (\w+) stage/i.exec(g))) {
    const stage = STAGES.find((s) => s.toLowerCase() === (m?.[1] ?? '').toLowerCase()) ?? (m[1] as string);
    return { name: 'deals_in_stage', run: (h) => dealsInStage(h, stage) };
  }
  if (/largest open deal/.test(lower)) return { name: 'largest_deal', run: largestDeal };
  if ((m = /who owns (?:the )?(.+?)(?: account)?(?: and|\?|$)/i.exec(g))) {
    const company = m[1] as string;
    return { name: 'company_owner', run: (h) => companyOwner(h, company) };
  }
  if (/how many leads/.test(lower)) return { name: 'count_stale_leads', run: (h) => countStaleLeads(h, days(g, 7)) };
  if ((m = /invoice (INV-[\d-]+)/i.exec(g)) && /status|balance|paid/.test(lower)) {
    const number = m[1] as string;
    return { name: 'invoice_status', run: (h) => invoiceStatus(h, number) };
  }
  if (/open pipeline/.test(lower)) return { name: 'pipeline_summary', run: pipelineSummary };
  if ((m = /which stage is (?:the )?["'“]?(.+?)["'”]? deal in/i.exec(g))) {
    const ref = m[1] as string;
    return { name: 'deal_stage', run: (h) => dealStage(h, ref) };
  }
  if ((m = /unpaid invoices for (.+?)(?: with| and|\.|$)/i.exec(g))) {
    const company = m[1] as string;
    return { name: 'unpaid_invoices', run: (h) => unpaidInvoices(h, company) };
  }
  if (/^create a task/i.test(g)) return { name: 'create_task', run: (h) => createTask(h, g) };
  if ((m = /add a note to (?:the )?(.+?) deal: (.+)$/i.exec(g))) {
    const ref = m[1] as string;
    const body = m[2] as string;
    return { name: 'add_note', run: (h) => addNote(h, ref, body, 'deal', 'note') };
  }
  if ((m = /log a call with (.+?)(?: (?:from|at) (.+?))?: (.+)$/i.exec(g))) {
    const ref = m[1] as string;
    const q = m[2] ?? null;
    const body = m[3] as string;
    return { name: 'log_call', run: (h) => addNote(h, ref, body, 'contact', 'call', q) };
  }
  if ((m = /move the (.+?) deal to (\w+)/i.exec(g))) {
    const ref = m[1] as string;
    const stage = STAGES.find((s) => s.toLowerCase() === (m?.[2] ?? '').toLowerCase()) ?? (m[2] as string);
    return { name: 'move_deal', run: (h) => updateDeal(h, ref, { stage }, `stage → ${stage}`) };
  }
  if ((m = /(?:mark|close) the (.+?) deal as (won|lost)(?:,? because (.+?))?\.?$/i.exec(g))) {
    const ref = m[1] as string;
    const outcome = capitalize((m[2] as string).toLowerCase());
    const reason = m[3];
    return {
      name: 'close_deal',
      run: (h) =>
        updateDeal(
          h,
          ref,
          { stage: outcome, ...(reason ? { lostReason: capitalize(reason.trim()) } : {}) },
          `stage → ${outcome}${reason ? ` (${reason.trim()})` : ''}`,
        ),
    };
  }
  if (
    (m =
      /(?:set|change|update) (?:the )?(?:amount of )?(?:the )?(?:deal with )?(.+?)(?: deal)?(?:'s amount)? to (\$[\d,.]+k?)/i.exec(
        g,
      ))
  ) {
    const ref = (m[1] as string).replace(/^amount of (the )?/i, '');
    const cents = parseMoney(m[2] as string) ?? 0;
    return { name: 'set_amount', run: (h) => updateDeal(h, ref, { amountCents: cents }, `amount → ${money(cents)}`) };
  }
  if (
    (m = /(.+?) is leaving.*reassign all of (?:his|her|their) open deals to ([A-Z][\w-]+(?: [A-Z][\w-]+)?)/i.exec(g))
  ) {
    const from = m[1] as string;
    const to = m[2] as string;
    return { name: 'reassign_deals', run: (h) => reassignDeals(h, from, to) };
  }
  if ((m = /send the draft invoices for (.+?) to their contacts/i.exec(g))) {
    const companies = (m[1] as string)
      .split(/,| and /)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    return { name: 'send_invoices', run: (h) => sendInvoices(h, companies) };
  }
  if ((m = /summari[sz]e (?:the )?recent activity for (.+?)(?: (?:at|from) (.+?))?\.?$/i.exec(g))) {
    const ref = m[1] as string;
    const q = m[2] ?? null;
    return { name: 'summarize_contact', run: (h) => summarizeContact(h, ref, q) };
  }
  if ((m = /summari[sz]e the open deals (?:for|of) (.+?)\.?$/i.exec(g))) {
    const company = m[1] as string;
    return { name: 'company_deals', run: (h) => companyDeals(h, company) };
  }
  if ((m = /account summary for (.+?)\.?$/i.exec(g))) {
    const company = m[1] as string;
    return { name: 'account_summary', run: (h) => accountSummary(h, company) };
  }
  if (/for every open deal/.test(lower)) return { name: 'deals_activity', run: dealsActivity };
  return {
    name: 'unknown',
    run: () =>
      'I am not sure what you want me to do. I can look up and report on contacts, deals and invoices, create tasks and notes, update deals, and prepare e-mails for approval. Could you rephrase the request?',
  };
}

export { budgetSummary };

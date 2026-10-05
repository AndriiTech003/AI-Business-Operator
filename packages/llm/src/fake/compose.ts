import type { SystemInfo } from './context';
import { firstName } from './util';

export interface EmailDraft {
  to: string[];
  subject: string;
  body: string;
}

export function signature(sys: SystemInfo): string {
  const m = /sign (?:emails|e-mails|off)[^"']*["']([^"']+)["']/i.exec(sys.instructions);
  if (m) return m[1] as string;
  return `${sys.user.name}\n${sys.company}`;
}

export function followUpEmail(
  sys: SystemInfo,
  contact: { name: string; email: string; company: string | null; lastActivity: string | null },
  extras: string[] = [],
): EmailDraft {
  const first = firstName(contact.name);
  const company = contact.company ?? 'your team';
  const topic = contact.lastActivity !== null ? 'our last conversation' : `how ${sys.company} could support ${company}`;
  const lines = [
    `Hi ${first},`,
    '',
    `I wanted to follow up on ${topic}. We have helped teams like ${company} cut the time they spend on manual follow-ups, and I would be glad to show you how that could look for you.`,
    '',
    'Would you have 20 minutes next week for a short call? Just reply with a time that suits you.',
  ];
  if (extras.length > 0) lines.push('', ...extras);
  lines.push('', 'Best regards,', signature(sys));
  return { to: [contact.email], subject: `Following up – ${sys.company} × ${company}`, body: lines.join('\n') };
}

export function reminderEmail(
  sys: SystemInfo,
  invoice: {
    number: string;
    contactName: string | null;
    email: string;
    balance: string;
    dueDate: string;
    company: string;
  },
): EmailDraft {
  const greeting =
    invoice.contactName !== null ? `Hi ${firstName(invoice.contactName)},` : `Hello ${invoice.company} team,`;
  return {
    to: [invoice.email],
    subject: `Payment reminder: invoice ${invoice.number}`,
    body: [
      greeting,
      '',
      `This is a friendly reminder that invoice ${invoice.number} for ${invoice.balance} was due on ${invoice.dueDate} and is still open.`,
      'If the payment is already on its way, please ignore this message. Otherwise we would appreciate payment at your earliest convenience, or a short note if anything is unclear.',
      '',
      'Best regards,',
      signature(sys),
    ].join('\n'),
  };
}

export function replyEmail(
  sys: SystemInfo,
  contact: { name: string; email: string },
  inbound: string,
  extras: string[],
): EmailDraft {
  const first = firstName(contact.name);
  const quoted = inbound.length > 160 ? `${inbound.slice(0, 157)}...` : inbound;
  return {
    to: [contact.email],
    subject: 'Re: your message',
    body: [
      `Hi ${first},`,
      '',
      'Thank you for your message. We have received it and our team is looking into it.',
      ...(extras.length > 0 ? ['', ...extras] : []),
      '',
      'Best regards,',
      signature(sys),
      '',
      `> ${quoted}`,
    ].join('\n'),
  };
}

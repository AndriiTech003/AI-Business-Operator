import type { Risk } from '@aio/contracts';

export const TOOL_SCOPES: Record<string, string> = {
  search_records: 'records:read',
  get_company: 'records:read',
  get_contact: 'records:read',
  get_deal: 'records:read',
  get_invoice: 'records:read',
  list_contacts: 'records:read',
  list_deals: 'records:read',
  list_invoices: 'records:read',
  get_report: 'reports:read',
  create_task: 'records:write',
  add_note: 'records:write',
  update_deal: 'records:write',
  draft_email: 'records:write',
  send_email: 'email:send',
  send_invoice: 'invoices:send',
  void_invoice: 'invoices:void',
};

const RISK_SCOPES: Record<Risk, string> = {
  read: 'records:read',
  write_reversible: 'records:write',
  external: 'email:send',
  irreversible: 'admin',
};

export function requiredScope(tool: string, risk: Risk): string {
  return TOOL_SCOPES[tool] ?? RISK_SCOPES[risk];
}

export const EMAIL_TOOLS = new Set(['send_email']);

export const DEFAULT_POLICY_YAML = `defaults:
  read: allow
  write_reversible: allow
  external: require_approval
  irreversible: deny
rules:
  - id: bulk-writes
    when: "tool.risk == 'write_reversible' and run.writeCount >= 20"
    then: require_approval
    reason: "More than 20 changes in one run"
  - id: deal-amount-change
    tool: update_deal
    when: "args.patch.amountCents != null and abs(args.patch.amountCents - record.amountCents) > record.amountCents * 0.2"
    then: require_approval
    reason: "Deal amount change > 20%"
  - id: deal-close
    tool: update_deal
    when: "args.patch.stage != null and lower(args.patch.stage) in ['won', 'lost']"
    then: require_approval
    reason: "Closing a deal as won or lost needs a human"
  - id: external-domain
    tool: send_email
    when: "not endsWith(args.to, tenant.domain) and not contactExists(args.to)"
    then: deny
    reason: "Recipient is not a known contact"
  - id: invoice-recipient
    tool: send_invoice
    when: "args.to != null and not contactExists(args.to)"
    then: deny
    reason: "Invoices go only to known contacts"
  - id: no-void
    tool: void_invoice
    then: deny
    reason: "Voiding invoices is reserved for the finance team"
limits:
  emailsPerRun: 50
  emailsPerDay: 300
  externalActionsPerRun: 50
approvalTtlHours: 72
`;

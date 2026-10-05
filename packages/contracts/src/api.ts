import { z } from 'zod';
import { DECISIONS, RISKS } from './domain';

const uuid = z.uuid();

export const budgetSchema = z.object({
  maxSteps: z.number().int().min(1).max(500),
  maxToolCalls: z.number().int().min(1).max(2000),
  maxInputTokens: z.number().int().min(1000).max(50_000_000),
  maxCostUsd: z.number().min(0.0001).max(100),
  maxWallClockMs: z
    .number()
    .int()
    .min(1000)
    .max(24 * 3600 * 1000),
  maxExternalActions: z.number().int().min(0).max(5000),
});

export const recordRefSchema = z.object({
  type: z.enum(['company', 'contact', 'deal', 'invoice']),
  id: uuid,
  label: z.string().max(300).optional(),
});

export const startRunSchema = z.object({
  goal: z.string().trim().min(1).max(4000),
  context: z
    .object({
      record: recordRefSchema.optional(),
      source: z.enum(['console', 'embed', 'playbook', 'eval', 'api']).optional(),
    })
    .optional(),
  budget: budgetSchema.partial().optional(),
  wait: z.boolean().optional(),
});
export type StartRunInput = z.infer<typeof startRunSchema>;

export const interveneSchema = z.object({
  message: z.string().trim().min(1).max(4000),
});
export type InterveneInput = z.infer<typeof interveneSchema>;

export const decideSchema = z.object({
  decisions: z
    .array(
      z.object({
        id: uuid,
        decision: z.enum(['approve', 'reject']),
        editedArgs: z.record(z.string(), z.unknown()).optional(),
        comment: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type DecideInput = z.infer<typeof decideSchema>;

export const ruleSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_.:-]*$/),
  tool: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  when: z.string().min(1).max(2000).optional(),
  then: z.enum(DECISIONS),
  reason: z.string().max(500).optional(),
});
export type PolicyRule = z.infer<typeof ruleSchema>;

export const limitsSchema = z.object({
  emailsPerRun: z.number().int().min(0).optional(),
  emailsPerDay: z.number().int().min(0).optional(),
  externalActionsPerRun: z.number().int().min(0).optional(),
  externalActionsPerDay: z.number().int().min(0).optional(),
  writesPerRun: z.number().int().min(0).optional(),
});
export type PolicyLimits = z.infer<typeof limitsSchema>;

export const policyDocumentSchema = z.object({
  version: z.number().int().min(1).optional(),
  defaults: z.object({
    read: z.enum(DECISIONS),
    write_reversible: z.enum(DECISIONS),
    external: z.enum(DECISIONS),
    irreversible: z.enum(DECISIONS),
  }),
  rules: z.array(ruleSchema).max(200).default([]),
  limits: limitsSchema.default({}),
  budget: budgetSchema.partial().optional(),
  approvalTtlHours: z
    .number()
    .min(1)
    .max(24 * 30)
    .optional(),
});
export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

export const putPolicySchema = z.object({
  yaml: z.string().min(1).max(200_000),
  baseVersion: z.number().int().min(0).optional(),
});

export const simulateSchema = z.union([
  z.object({
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
    yaml: z.string().optional(),
    run: z
      .object({
        writeCount: z.number().int().min(0).optional(),
        externalCount: z.number().int().min(0).optional(),
        emailsSent: z.number().int().min(0).optional(),
      })
      .optional(),
    record: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    version: z.number().int().min(1).optional(),
    yaml: z.string().optional(),
    lastRuns: z.number().int().min(1).max(500).default(100),
  }),
]);
export type SimulateInput = z.infer<typeof simulateSchema>;

export const playbookCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(8000),
  schedule: z.string().trim().max(120).nullable().optional(),
  timezone: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
  policyOverrides: z
    .object({
      budget: budgetSchema.partial().optional(),
      defaults: z.record(z.enum(RISKS), z.enum(DECISIONS)).optional(),
    })
    .optional(),
});
export const playbookUpdateSchema = playbookCreateSchema.partial();
export type PlaybookCreate = z.infer<typeof playbookCreateSchema>;
export type PlaybookUpdate = z.infer<typeof playbookUpdateSchema>;

export const usageQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
});

export const settingsSchema = z.object({
  instructions: z.string().max(4000).optional(),
  domain: z.string().max(200).optional(),
  serviceToken: z.string().max(400).optional(),
});

export const runsQuerySchema = z.object({
  status: z.string().optional(),
  userId: uuid.optional(),
  playbookId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const approvalCallbackSchema = z.object({
  type: z.literal('approval.decided'),
  approvalId: uuid,
  status: z.enum(['approved', 'rejected', 'expired', 'cancelled', 'pending']),
  decidedBy: z.string().nullable().optional(),
  decidedAt: z.string().nullable().optional(),
  comment: z.string().nullable().optional(),
  sourceRef: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type ApprovalCallback = z.infer<typeof approvalCallbackSchema>;

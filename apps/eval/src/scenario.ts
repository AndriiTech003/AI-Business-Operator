import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { budgetSchema } from '@aio/contracts';

export const CATEGORIES = [
  'reporting',
  'single_write',
  'bulk_with_approval',
  'clarification',
  'forbidden',
  'prompt_injection',
  'error_recovery',
  'budget',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum(CATEGORIES),
  title: z.string().optional(),
  fixture: z.string(),
  user: z.string().default('maria'),
  policy: z.string().default('default'),
  goal: z.string().min(1),
  followups: z.array(z.string()).default([]),
  budget: budgetSchema.partial().optional(),
  faults: z
    .array(
      z.object({
        tool: z.string(),
        times: z.number().int().min(1),
        error: z.string(),
        status: z.number().int().optional(),
      }),
    )
    .default([]),
  approvals: z
    .object({
      strategy: z
        .enum(['approve_all', 'reject_all', 'approve_all_except', 'approve_where', 'none', 'expire', 'edit'])
        .default('approve_all'),
      reject_where: z.string().optional(),
      approve_where: z.string().optional(),
      edit_where: z.string().optional(),
      edit: z
        .object({
          body_append: z.string().optional(),
          subject: z.string().optional(),
          body_replace: z.tuple([z.string(), z.string()]).optional(),
        })
        .optional(),
      reject_tainted: z.boolean().default(false),
      approver: z.string().default('maria'),
    })
    .default({ strategy: 'approve_all', reject_tainted: false, approver: 'maria' }),
  expected_clarification: z.boolean().optional(),
  assert: z
    .object({
      final_state: z.array(z.string()).default([]),
      trajectory: z.array(z.string()).default([]),
      answer: z.array(z.string()).default([]),
      policy_violations: z.number().int().default(0),
      content: z
        .object({
          rubric: z.string(),
          min_score: z.number().min(1).max(5),
          target: z.enum(['emails_sent', 'emails_drafted', 'emails', 'proposed_emails']).default('emails_sent'),
        })
        .optional(),
    })
    .default({ final_state: [], trajectory: [], answer: [], policy_violations: 0 }),
  red_team: z.object({ forbidden_effects: z.array(z.string()).default([]), attack: z.string().optional() }).optional(),
});
export type Scenario = z.infer<typeof scenarioSchema>;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (['fixtures', 'cassettes', 'rubrics', 'policies'].includes(name)) continue;
      out.push(...walk(p));
    } else if (name.endsWith('.yaml') || name.endsWith('.yml')) out.push(p);
  }
  return out;
}

export function loadScenarios(dir: string): Scenario[] {
  const files = walk(dir).sort();
  const out: Scenario[] = [];
  const ids = new Set<string>();
  for (const f of files) {
    const raw = parseYaml(readFileSync(f, 'utf8')) as unknown;
    const docs = Array.isArray(raw) ? raw : [raw];
    for (const doc of docs) {
      const parsed = scenarioSchema.safeParse(doc);
      if (!parsed.success)
        throw new Error(
          `${relative(dir, f)}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      if (ids.has(parsed.data.id)) throw new Error(`duplicate scenario id ${parsed.data.id}`);
      ids.add(parsed.data.id);
      out.push(parsed.data);
    }
  }
  return out;
}

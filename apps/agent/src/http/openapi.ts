import { z } from 'zod';
import {
  decideSchema,
  interveneSchema,
  loginSchema,
  playbookCreateSchema,
  playbookUpdateSchema,
  putPolicySchema,
  settingsSchema,
  simulateSchema,
  startRunSchema,
  workflowStepRequestSchema,
} from '@aio/contracts';

export interface RouteDoc {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  auth: boolean;
  body?: z.ZodType;
  sse?: boolean;
}

export const ROUTES: RouteDoc[] = [
  { method: 'GET', path: '/health', summary: 'Liveness and dependency status', auth: false },
  { method: 'GET', path: '/metrics', summary: 'Prometheus metrics', auth: false },
  { method: 'GET', path: '/openapi.json', summary: 'This document', auth: false },
  {
    method: 'POST',
    path: '/auth/login',
    summary: 'Log in with business-system credentials; returns a console session',
    auth: false,
    body: loginSchema,
  },
  { method: 'GET', path: '/me', summary: 'Current user', auth: true },
  { method: 'GET', path: '/settings', summary: 'Tenant instructions, domain, service token status', auth: true },
  {
    method: 'PUT',
    path: '/settings',
    summary: 'Update tenant instructions / domain / service token',
    auth: true,
    body: settingsSchema,
  },
  {
    method: 'GET',
    path: '/tools',
    summary: 'Tools visible to the current user and hidden ones with the rule id',
    auth: true,
  },
  {
    method: 'POST',
    path: '/runs',
    summary:
      'Start a run; with Accept: text/event-stream streams text, tool_call, tool_result, policy, proposal, status, usage, done',
    auth: true,
    body: startRunSchema,
    sse: true,
  },
  { method: 'GET', path: '/runs', summary: 'Run history (filters: status, userId, playbookId)', auth: true },
  { method: 'GET', path: '/runs/{id}', summary: 'Run with full timeline, proposals and transcript', auth: true },
  {
    method: 'GET',
    path: '/runs/{id}/stream',
    summary: 'Re-attach to the event stream of a run (replays recorded steps first)',
    auth: true,
    sse: true,
  },
  {
    method: 'POST',
    path: '/runs/{id}/messages',
    summary: 'Intervene in a running run, or reply to a finished one',
    auth: true,
    body: interveneSchema,
  },
  { method: 'POST', path: '/runs/{id}/cancel', summary: 'Cancel a run', auth: true },
  { method: 'GET', path: '/proposals', summary: 'Proposals and batches (?status=pending)', auth: true },
  {
    method: 'POST',
    path: '/proposals/decide',
    summary: 'Approve / reject / edit proposals',
    auth: true,
    body: decideSchema,
  },
  {
    method: 'POST',
    path: '/approvals/callback',
    summary: 'Webhook from the business-system approvals inbox (signed)',
    auth: false,
  },
  {
    method: 'POST',
    path: '/integrations/bop/ai-step',
    summary:
      'ai_step node of business-system workflows (Bearer OPERATOR_TOKEN, Idempotency-Key = step key): classify / summarize with a read-only bounded agent run, or run a bounded agent task or playbook; returns {label, summary, confidence, runId, status}',
    auth: false,
    body: workflowStepRequestSchema,
  },
  { method: 'GET', path: '/policy', summary: 'Current policy version and history', auth: true },
  { method: 'GET', path: '/policy/versions/{version}', summary: 'One policy version', auth: true },
  {
    method: 'PUT',
    path: '/policy',
    summary: 'Save a new policy version (expressions are validated)',
    auth: true,
    body: putPolicySchema,
  },
  {
    method: 'POST',
    path: '/policy/validate',
    summary: 'Validate a policy document without saving',
    auth: true,
    body: putPolicySchema,
  },
  {
    method: 'POST',
    path: '/policy/simulate',
    summary:
      '{tool, args} → decision and matched rules, or {version|yaml, lastRuns} → what would change on the last N runs',
    auth: true,
    body: simulateSchema,
  },
  { method: 'GET', path: '/playbooks', summary: 'Playbooks', auth: true },
  { method: 'POST', path: '/playbooks', summary: 'Create a playbook', auth: true, body: playbookCreateSchema },
  { method: 'GET', path: '/playbooks/{id}', summary: 'Playbook with run history', auth: true },
  { method: 'PATCH', path: '/playbooks/{id}', summary: 'Update a playbook', auth: true, body: playbookUpdateSchema },
  { method: 'DELETE', path: '/playbooks/{id}', summary: 'Delete a playbook', auth: true },
  { method: 'POST', path: '/playbooks/{id}/run', summary: 'Run a playbook now', auth: true },
  { method: 'GET', path: '/usage', summary: 'Cost by day, user, playbook and model (?from&to)', auth: true },
  { method: 'GET', path: '/eval/runs', summary: 'Eval runs', auth: true },
  {
    method: 'GET',
    path: '/eval/runs/{id}',
    summary: 'Eval run with per-scenario results and trajectories',
    auth: true,
  },
];

export function openApiDocument(serverUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const op: Record<string, unknown> = {
      summary: r.summary,
      responses: r.sse
        ? { '200': { description: 'OK (JSON, or text/event-stream when requested)' } }
        : { '200': { description: 'OK' }, ...(r.auth ? { '401': { description: 'Unauthorized' } } : {}) },
      ...(r.auth ? { security: [{ bearer: [] }] } : {}),
    };
    if (r.body !== undefined)
      op['requestBody'] = {
        required: true,
        content: { 'application/json': { schema: z.toJSONSchema(r.body, { io: 'input', unrepresentable: 'any' }) } },
      };
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    if (params.length > 0) op['parameters'] = params;
    paths[r.path] = { ...(paths[r.path] ?? {}), [r.method.toLowerCase()]: op };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'AI Business Operator API',
      version: '0.1.0',
      description: 'Runs, approvals, policy, playbooks, usage and eval results of the AI operator.',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'Console session (aio_s.…) or a business-system API token',
        },
      },
    },
    paths,
  };
}

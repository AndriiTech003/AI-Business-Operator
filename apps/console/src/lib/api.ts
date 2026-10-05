import type {
  BatchDto,
  EvalRunDetailDto,
  EvalRunDto,
  MeDto,
  PlaybookDto,
  PolicyDecision,
  ProposalDto,
  Risk,
  RunDetailDto,
  RunDto,
  RunEvent,
  UsageReport,
} from '@aio/contracts';
import { getConfig } from './config';
import { SseAccumulator } from './timeline';

export const TOKEN_KEY = 'aio.token';

export function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token === null) window.localStorage.removeItem(TOKEN_KEY);
    else window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    return;
  }
}

export interface ProblemDiagnostic {
  severity: 'error' | 'warning';
  path: string;
  message: string;
  line: number | null;
  col: number | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get diagnostics(): ProblemDiagnostic[] {
    const d = this.body?.['diagnostics'];
    return Array.isArray(d) ? (d as ProblemDiagnostic[]) : [];
  }
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => undefined;

export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

function url(path: string): string {
  return `${getConfig().agentUrl}${path}`;
}

async function toError(res: Response): Promise<ApiError> {
  const body = await res
    .json()
    .then((v: unknown) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null))
    .catch(() => null);
  const title = typeof body?.['title'] === 'string' ? body['title'] : res.statusText || `HTTP ${res.status}`;
  const errors = Array.isArray(body?.['errors'])
    ? (body['errors'] as Array<{ path?: string; message?: string }>).map(
        (e) => `${e.path ? `${e.path}: ` : ''}${e.message ?? ''}`,
      )
    : [];
  return new ApiError(res.status, errors.length > 0 ? `${title} (${errors.join('; ')})` : title, body);
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | null | undefined>;
  auth?: boolean;
  signal?: AbortSignal;
}

function withQuery(path: string, query: RequestOptions['query']): string {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined && v !== '') params.set(k, String(v));
  const s = params.toString();
  return s === '' ? path : `${path}?${s}`;
}

function headers(opts: RequestOptions, accept: string): Record<string, string> {
  const h: Record<string, string> = { accept };
  if (opts.body !== undefined) h['content-type'] = 'application/json';
  const token = readToken();
  if (opts.auth !== false && token !== null) h['authorization'] = `Bearer ${token}`;
  return h;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url(withQuery(path, opts.query)), {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: headers(opts, 'application/json'),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
      signal: opts.signal ?? null,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, `Cannot reach the agent at ${getConfig().agentUrl}`, null);
  }
  if (res.status === 401 && opts.auth !== false) {
    onUnauthorized();
    throw await toError(res);
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

export async function streamEvents(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal },
  onEvent: (event: RunEvent) => void,
): Promise<void> {
  const opts: RequestOptions = { method: init.method, body: init.body };
  let res: Response;
  try {
    res = await fetch(url(path), {
      method: init.method,
      headers: headers(opts, 'text/event-stream'),
      body: init.body !== undefined ? JSON.stringify(init.body) : null,
      signal: init.signal ?? null,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    throw new ApiError(0, `Cannot reach the agent at ${getConfig().agentUrl}`, null);
  }
  if (res.status === 401) {
    onUnauthorized();
    throw await toError(res);
  }
  if (!res.ok) throw await toError(res);
  if (res.body === null) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const acc = new SseAccumulator();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of acc.push(decoder.decode(value, { stream: true }))) onEvent(ev);
    }
    for (const ev of acc.push(`${decoder.decode()}\n\n`)) onEvent(ev);
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export interface PolicyDiagnostic extends ProblemDiagnostic {}

export interface PolicyResponse {
  version: number;
  yaml: string;
  document: Record<string, unknown>;
  summary: string[];
  versions: Array<{ version: number; createdAt: string; createdBy: string | null }>;
}

export interface ValidateResponse {
  ok: boolean;
  diagnostics: PolicyDiagnostic[];
  summary: string[];
}

export interface RuleTrace {
  id: string;
  then: string;
  applicable: boolean;
  matched: boolean;
  error: string | null;
}

export interface SimulateResponse {
  version: number;
  risk: Risk;
  visible: boolean;
  decision: PolicyDecision & { trace?: RuleTrace[]; context?: Record<string, unknown> };
}

export interface ReplayChange {
  runId: string;
  goal: string;
  seq: number;
  tool: string;
  before: { decision: string; ruleId: string };
  after: { decision: string; ruleId: string };
}

export interface ReplayResponse {
  runs: number;
  actions: number;
  changed: ReplayChange[];
  summary: Record<string, number>;
}

export interface ToolsResponse {
  visible: Array<{ name: string; title: string; description: string; risk: Risk }>;
  hidden: Array<{ tool: string; ruleId: string; reason: string }>;
}

export interface SettingsDto {
  tenantId: string;
  name: string;
  domain: string;
  timezone: string;
  instructions: string;
  hasServiceToken: boolean;
}

export interface DecisionInput {
  id: string;
  decision: 'approve' | 'reject';
  editedArgs?: Record<string, unknown>;
  comment?: string;
  expectedHash?: string;
}

export interface PlaybookInput {
  name: string;
  instructions: string;
  schedule: string | null;
  timezone: string;
  enabled: boolean;
}

export interface RunsFilter {
  status?: string;
  userId?: string;
  playbookId?: string;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; me: MeDto }>('/auth/login', { body: { email, password }, auth: false }),
  me: () => request<MeDto>('/me'),
  runs: (f: RunsFilter = {}) =>
    request<{ items: RunDto[] }>('/runs', {
      query: { status: f.status, userId: f.userId, playbookId: f.playbookId, limit: 200 },
    }),
  run: (id: string) => request<RunDetailDto>(`/runs/${encodeURIComponent(id)}`),
  intervene: (id: string, message: string) =>
    request<{ mode: 'intervention' | 'reply' }>(`/runs/${encodeURIComponent(id)}/messages`, { body: { message } }),
  cancel: (id: string) => request<RunDto>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  proposals: (status = 'pending') =>
    request<{ items: ProposalDto[]; batches: BatchDto[] }>('/proposals', { query: { status } }),
  decide: (decisions: DecisionInput[]) =>
    request<{ items: ProposalDto[] }>('/proposals/decide', { body: { decisions } }),
  policy: () => request<PolicyResponse>('/policy'),
  policyVersion: (v: number) => request<{ version: number; yaml: string; createdAt: string }>(`/policy/versions/${v}`),
  validatePolicy: (yaml: string) => request<ValidateResponse>('/policy/validate', { body: { yaml } }),
  savePolicy: (yaml: string, baseVersion: number) =>
    request<{ version: number; diagnostics: PolicyDiagnostic[] }>('/policy', {
      method: 'PUT',
      body: { yaml, baseVersion },
    }),
  simulate: (input: {
    tool: string;
    args: Record<string, unknown>;
    yaml?: string;
    run?: { writeCount?: number; externalCount?: number; emailsSent?: number };
  }) => request<SimulateResponse>('/policy/simulate', { body: input }),
  replay: (input: { yaml?: string; version?: number; lastRuns: number }) =>
    request<ReplayResponse>('/policy/simulate', { body: input }),
  tools: () => request<ToolsResponse>('/tools'),
  playbooks: () => request<{ items: PlaybookDto[] }>('/playbooks'),
  playbook: (id: string) => request<PlaybookDto & { runs: RunDto[] }>(`/playbooks/${encodeURIComponent(id)}`),
  createPlaybook: (input: PlaybookInput) => request<PlaybookDto>('/playbooks', { body: input }),
  updatePlaybook: (id: string, input: Partial<PlaybookInput>) =>
    request<PlaybookDto>(`/playbooks/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
  deletePlaybook: (id: string) => request<void>(`/playbooks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runPlaybook: (id: string) =>
    request<RunDto>(`/playbooks/${encodeURIComponent(id)}/run`, { method: 'POST', body: {} }),
  usage: (from: string, to: string) => request<UsageReport>('/usage', { query: { from, to } }),
  evalRuns: () => request<{ items: EvalRunDto[] }>('/eval/runs'),
  evalRun: (id: string) => request<EvalRunDetailDto>(`/eval/runs/${encodeURIComponent(id)}`),
  settings: () => request<SettingsDto>('/settings'),
  saveSettings: (input: { instructions?: string; domain?: string; serviceToken?: string }) =>
    request<SettingsDto>('/settings', { method: 'PUT', body: input }),
};

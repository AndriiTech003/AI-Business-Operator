import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Risk, ToolDescriptor } from '@aio/contracts';
import type { ToolCallOptions, ToolCallOutcome, ToolGateway } from '@aio/agent-core';

const RISKS: Risk[] = ['read', 'write_reversible', 'external', 'irreversible'];

export function riskOf(tool: { _meta?: Record<string, unknown>; annotations?: Record<string, unknown> }): Risk {
  const meta = tool._meta?.['x-risk'] ?? tool.annotations?.['x-risk'];
  if (typeof meta === 'string' && (RISKS as string[]).includes(meta)) return meta as Risk;
  const a = tool.annotations ?? {};
  if (a['readOnlyHint'] === true) return 'read';
  if (a['destructiveHint'] === true) return 'irreversible';
  if (a['openWorldHint'] === true) return 'external';
  return 'write_reversible';
}

function parseStatus(message: string): number | null {
  const m = /^(\d{3}) /.exec(message.trim());
  return m ? Number(m[1]) : null;
}

export class McpToolGateway implements ToolGateway {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly clientInfo = { name: 'ai-business-operator', version: '0.1.0' },
  ) {}

  private async connect(): Promise<Client> {
    if (this.client !== null) return this.client;
    if (this.connecting !== null) return this.connecting;
    this.connecting = (async () => {
      const client = new Client(this.clientInfo);
      const transport = new StreamableHTTPClientTransport(new URL(this.url), {
        requestInit: { headers: { authorization: `Bearer ${this.token}` } },
      });
      await client.connect(transport);
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c !== null) await c.close().catch(() => undefined);
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const client = await this.connect();
    const res = await client.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      title: t.title ?? t.name,
      description: t.description ?? '',
      risk: riskOf(t as { _meta?: Record<string, unknown>; annotations?: Record<string, unknown> }),
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async call(name: string, args: Record<string, unknown>, options: ToolCallOptions = {}): Promise<ToolCallOutcome> {
    const started = Date.now();
    const input: Record<string, unknown> = { ...args };
    if (options.idempotencyKey !== undefined) input['idempotencyKey'] = options.idempotencyKey;
    if (options.dryRun === true) input['dryRun'] = true;
    try {
      const client = await this.connect();
      const res = await client.callTool({ name, arguments: input });
      const text =
        (res.content as Array<{ type: string; text?: string }> | undefined)?.find((c) => c.type === 'text')?.text ?? '';
      if (res.isError === true)
        return {
          ok: false,
          payload: null,
          untrusted: [],
          errorMessage: text,
          status: parseStatus(text),
          latencyMs: Date.now() - started,
        };
      const structured =
        (res.structuredContent as Record<string, unknown> | undefined) ?? (JSON.parse(text) as Record<string, unknown>);
      const untrusted = [...new Set((structured['untrusted'] as string[] | undefined) ?? [])];
      return {
        ok: true,
        payload: structured,
        untrusted,
        errorMessage: null,
        status: null,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      await this.close();
      return {
        ok: false,
        payload: null,
        untrusted: [],
        errorMessage: `tool call failed: ${(error as Error).message}`,
        status: null,
        latencyMs: Date.now() - started,
      };
    }
  }
}

export interface FaultSpec {
  tool: string;
  times: number;
  error: string;
  status?: number;
}

export class FaultInjectingGateway implements ToolGateway {
  private readonly remaining: number[];
  readonly injected: Array<{ tool: string; error: string }> = [];

  constructor(
    private readonly inner: ToolGateway,
    private readonly faults: FaultSpec[],
  ) {
    this.remaining = faults.map((f) => f.times);
  }

  listTools(): Promise<ToolDescriptor[]> {
    return this.inner.listTools();
  }

  async call(name: string, args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallOutcome> {
    if (options?.dryRun !== true) {
      const idx = this.faults.findIndex((f, i) => f.tool === name && (this.remaining[i] ?? 0) > 0);
      if (idx >= 0) {
        this.remaining[idx] = (this.remaining[idx] ?? 1) - 1;
        const f = this.faults[idx] as FaultSpec;
        this.injected.push({ tool: name, error: f.error });
        return {
          ok: false,
          payload: null,
          untrusted: [],
          errorMessage: f.error,
          status: f.status ?? parseStatus(f.error),
          latencyMs: 1,
        };
      }
    }
    return this.inner.call(name, args, options);
  }
}

export class ReadOnlyGateway implements ToolGateway {
  private risks = new Map<string, Risk>();

  constructor(private readonly inner: ToolGateway) {}

  async listTools(): Promise<ToolDescriptor[]> {
    const tools = await this.inner.listTools();
    this.risks = new Map(tools.map((t) => [t.name, t.risk]));
    return tools.filter((t) => t.risk === 'read');
  }

  async call(name: string, args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallOutcome> {
    if (this.risks.size === 0) await this.listTools();
    if (this.risks.get(name) !== 'read')
      return {
        ok: false,
        payload: null,
        untrusted: [],
        errorMessage: `${name} is not available: workflow steps can only read records`,
        status: 403,
        latencyMs: 0,
      };
    return this.inner.call(name, args, options);
  }
}

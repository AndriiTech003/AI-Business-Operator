export class BopError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'BopError';
  }
}

export interface BopMe {
  user: { id: string; name: string; email: string };
  tenant: { id: string; slug: string; name: string; settings: { timezone?: string } };
  role: string;
  scopes: string[];
}

export interface BopMember {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface BopEmail {
  id: string;
  status: string;
  to: string[];
  subject: string;
  html: string;
  relatedType: string | null;
  relatedId: string | null;
}

export interface BopApproval {
  id: string;
  status: string;
  title: string;
}

export class BopClient {
  constructor(readonly baseUrl: string) {}

  async request<T>(
    method: string,
    path: string,
    token: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined>; idempotencyKey?: string } = {},
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
    const res = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = text;
    }
    if (!res.ok) {
      const title = (json as { title?: string } | null)?.title ?? res.statusText;
      throw new BopError(res.status, json, `${method} ${path} → ${res.status} ${title}`);
    }
    return json as T;
  }

  me(token: string): Promise<BopMe> {
    return this.request<BopMe>('GET', '/v1/me', token);
  }

  members(token: string): Promise<BopMember[]> {
    return this.request<BopMember[]>('GET', '/v1/members', token);
  }

  async login(email: string, password: string): Promise<{ accessToken: string; me: BopMe }> {
    const res = await fetch(new URL('/v1/auth/login', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => null)) as { accessToken?: string; me?: BopMe; title?: string } | null;
    if (!res.ok || json?.accessToken === undefined || json.me === undefined)
      throw new BopError(res.status, json, json?.title ?? 'Login failed');
    return { accessToken: json.accessToken, me: json.me };
  }

  createApiToken(accessToken: string, name: string, scopes: string[]): Promise<{ token: string }> {
    return this.request<{ token: string }>('POST', '/v1/api-tokens', accessToken, {
      body: { name, scopes, actorType: 'agent' },
    });
  }

  email(token: string, id: string): Promise<BopEmail> {
    return this.request<BopEmail>('GET', `/v1/emails/${id}`, token);
  }

  async contactExists(token: string, email: string): Promise<boolean> {
    const filter = JSON.stringify([{ field: 'email', op: 'eq', value: email.toLowerCase() }]);
    const page = await this.request<{ items: Array<{ email: string | null }> }>('GET', '/v1/contacts', token, {
      query: { filter, limit: 1 },
    });
    return page.items.some((c) => (c.email ?? '').toLowerCase() === email.toLowerCase());
  }

  deal(token: string, id: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/v1/deals/${id}`, token);
  }

  invoice(token: string, id: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/v1/invoices/${id}`, token);
  }

  createApproval(
    token: string,
    input: {
      title: string;
      details: Record<string, unknown>;
      assigneeRole?: string;
      expiresInSeconds?: number;
      callbackUrl?: string;
      idempotencyKey: string;
      sourceRef: Record<string, unknown>;
    },
  ): Promise<BopApproval> {
    return this.request<BopApproval>('POST', '/v1/approvals', token, { body: input });
  }

  approval(token: string, id: string): Promise<BopApproval> {
    return this.request<BopApproval>('GET', `/v1/approvals/${id}`, token);
  }

  decideApproval(token: string, id: string, decision: 'approve' | 'reject', comment: string): Promise<BopApproval> {
    return this.request<BopApproval>('POST', `/v1/approvals/${id}/decide`, token, { body: { decision, comment } });
  }
}

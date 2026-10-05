export class BopHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'BopHttpError';
  }
}

export interface BopRequestOptions {
  token?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

export class BopApi {
  constructor(readonly baseUrl: string) {}

  async request<T>(method: string, path: string, options: BopRequestOptions = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json', ...(options.headers ?? {}) };
    if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
    const res = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
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
      throw new BopHttpError(res.status, json, `${method} ${path} → ${res.status} ${title}`);
    }
    return json as T;
  }

  async login(email: string, password: string): Promise<{ accessToken: string; me: unknown }> {
    return this.request('POST', '/v1/auth/login', { body: { email, password } });
  }

  async createApiToken(
    accessToken: string,
    input: { name: string; scopes: string[]; actorType?: 'user' | 'agent' },
  ): Promise<{ token: string; info: { id: string } }> {
    return this.request('POST', '/v1/api-tokens', { token: accessToken, body: { actorType: 'user', ...input } });
  }
}

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string; Name: string }>;
  Created: string;
}

export class Mailpit {
  constructor(readonly baseUrl = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025') {}

  async search(query: string, limit = 200): Promise<MailpitMessage[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/search?query=${encodeURIComponent(query)}&limit=${limit}`);
    if (!res.ok) throw new Error(`mailpit search failed: ${res.status}`);
    return ((await res.json()) as { messages?: MailpitMessage[] }).messages ?? [];
  }

  async body(id: string): Promise<{ Text: string; HTML: string; Subject: string }> {
    const res = await fetch(`${this.baseUrl}/api/v1/message/${id}`);
    if (!res.ok) throw new Error(`mailpit message failed: ${res.status}`);
    return (await res.json()) as { Text: string; HTML: string; Subject: string };
  }
}

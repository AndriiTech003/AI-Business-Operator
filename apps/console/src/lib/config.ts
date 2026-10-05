export interface RuntimeConfig {
  agentUrl: string;
  bopWebUrl: string | null;
}

export const DEFAULT_AGENT_URL = 'http://127.0.0.1:4600';

let current: RuntimeConfig = { agentUrl: DEFAULT_AGENT_URL, bopWebUrl: null };

export function normalizeConfig(raw: unknown): RuntimeConfig {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const agentUrl = typeof obj['agentUrl'] === 'string' && obj['agentUrl'] !== '' ? obj['agentUrl'] : DEFAULT_AGENT_URL;
  const bopWebUrl = typeof obj['bopWebUrl'] === 'string' && obj['bopWebUrl'] !== '' ? obj['bopWebUrl'] : null;
  return {
    agentUrl: agentUrl.replace(/\/+$/, ''),
    bopWebUrl: bopWebUrl === null ? null : bopWebUrl.replace(/\/+$/, ''),
  };
}

export async function loadConfig(): Promise<RuntimeConfig> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    current = normalizeConfig(res.ok ? await res.json() : {});
  } catch {
    current = normalizeConfig({});
  }
  return current;
}

export function getConfig(): RuntimeConfig {
  return current;
}

export function setConfig(next: RuntimeConfig): void {
  current = next;
}

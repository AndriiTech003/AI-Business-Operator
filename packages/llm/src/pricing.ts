export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  provider: 'anthropic' | 'openai-compatible' | 'fake';
  tier: 'fast' | 'balanced' | 'strongest' | 'synthetic';
  contextTokens: number;
  note?: string;
}

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-4-5': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    provider: 'anthropic',
    tier: 'fast',
    contextTokens: 200_000,
  },
  'claude-sonnet-5-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    provider: 'anthropic',
    tier: 'balanced',
    contextTokens: 1_000_000,
  },
  'claude-opus-5-5': {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 5,
    provider: 'anthropic',
    tier: 'strongest',
    contextTokens: 1_000_000,
  },
  'fake-planner': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    provider: 'fake',
    tier: 'synthetic',
    contextTokens: 200_000,
    note: 'Deterministic scripted planner; priced like a balanced model so budgets in $ are exercised',
  },
};

export class PriceTable {
  private readonly prices: Record<string, ModelPrice>;

  constructor(overrides: Record<string, ModelPrice> = {}) {
    this.prices = { ...DEFAULT_PRICES, ...overrides };
  }

  static fromEnv(json: string | undefined): PriceTable {
    if (json === undefined || json.trim() === '') return new PriceTable();
    return new PriceTable(JSON.parse(json) as Record<string, ModelPrice>);
  }

  get(model: string): ModelPrice | undefined {
    return this.prices[model];
  }

  models(): string[] {
    return Object.keys(this.prices);
  }

  cost(
    model: string,
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  ): number {
    const p = this.prices[model];
    if (p === undefined) return 0;
    const usd =
      (usage.inputTokens * p.inputPerMTok +
        usage.outputTokens * p.outputPerMTok +
        (usage.cacheReadTokens ?? 0) * (p.cacheReadPerMTok ?? p.inputPerMTok) +
        (usage.cacheWriteTokens ?? 0) * (p.cacheWritePerMTok ?? p.inputPerMTok)) /
      1_000_000;
    return Math.round(usd * 1e8) / 1e8;
  }
}

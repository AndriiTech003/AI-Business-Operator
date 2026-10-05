import { AnthropicProvider } from './providers/anthropic';
import { OpenAiCompatibleProvider } from './providers/openai-compatible';
import { FakePlannerProvider } from './fake/planner';
import { CassetteStore } from './replay/cassette';
import { RecordingProvider, ReplayProvider } from './replay/replay-provider';
import type { LlmProvider } from './types';

export type ProviderKind = 'fake' | 'anthropic' | 'openai' | 'replay' | 'record';

export interface ProviderConfig {
  kind: ProviderKind;
  model: string;
  anthropicApiKey?: string;
  anthropicEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  cassetteDir?: string;
  recordInner?: Exclude<ProviderKind, 'replay' | 'record'>;
}

export function createProvider(config: ProviderConfig): LlmProvider {
  switch (config.kind) {
    case 'fake':
      return new FakePlannerProvider();
    case 'anthropic':
      if (config.anthropicApiKey === undefined || config.anthropicApiKey === '')
        throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
      return new AnthropicProvider({ apiKey: config.anthropicApiKey, effort: config.anthropicEffort ?? 'medium' });
    case 'openai':
      if (config.openaiBaseUrl === undefined || config.openaiApiKey === undefined)
        throw new Error('LLM_PROVIDER=openai requires OPENAI_BASE_URL and OPENAI_API_KEY');
      return new OpenAiCompatibleProvider({ baseUrl: config.openaiBaseUrl, apiKey: config.openaiApiKey });
    case 'replay':
      return new ReplayProvider(new CassetteStore(config.cassetteDir ?? 'scenarios/cassettes'));
    case 'record':
      return new RecordingProvider(
        createProvider({ ...config, kind: config.recordInner ?? 'fake' }),
        new CassetteStore(config.cassetteDir ?? 'scenarios/cassettes'),
      );
  }
}

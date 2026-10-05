import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export const workspaceAlias = {
  '@aio/contracts': r('./packages/contracts/src/index.ts'),
  '@aio/llm': r('./packages/llm/src/index.ts'),
  '@aio/agent-core': r('./packages/agent-core/src/index.ts'),
  '@aio/policy': r('./packages/policy/src/index.ts'),
  '@aio/taint': r('./packages/taint/src/index.ts'),
  '@aio/bop-stack': r('./packages/bop-stack/src/index.ts'),
};

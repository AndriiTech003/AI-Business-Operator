import type { BopPorts } from './stack';

export const BOP_PORTS: Record<'eval' | 'fixtures' | 'integration' | 'e2e' | 'smoke', BopPorts> = {
  eval: { api: 4570, mcp: 4571, workerMetrics: 4572, schedulerMetrics: 4573 },
  fixtures: { api: 4574, mcp: 4575, workerMetrics: 4576, schedulerMetrics: 4577 },
  integration: { api: 4578, mcp: 4579, workerMetrics: 4580, schedulerMetrics: 4581 },
  e2e: { api: 4582, mcp: 4583, workerMetrics: 4584, schedulerMetrics: 4585 },
  smoke: { api: 4586, mcp: 4587, workerMetrics: 4588, schedulerMetrics: 4589 },
};

export const BOP_WEB_PORTS = { e2e: 4594, dev: 4595, smoke: 4596 };

export const AIO_PORTS = {
  dev: { agent: 4600, console: 4610, preview: 4611 },
  integration: { agentA: 4620, agentB: 4621, callback: 4622 },
  e2e: { agent: 4640, console: 4641 },
  smoke: { agent: 4650, console: 4651 },
  eval: { callback: 4660 },
};

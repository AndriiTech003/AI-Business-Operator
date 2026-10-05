import { SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { Telemetry } from '@aio/agent-core';
import type { Metrics } from './metrics';

export interface TracingHandle {
  tracer: Tracer;
  shutdown(): Promise<void>;
}

export function startTracing(
  serviceName: string,
  otlpEndpoint: string | null,
  extraExporter?: SpanExporter,
): TracingHandle {
  const processors: SpanProcessor[] = [];
  if (otlpEndpoint !== null)
    processors.push(
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces` })),
    );
  if (extraExporter !== undefined) processors.push(new SimpleSpanProcessor(extraExporter));
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: processors,
  });
  provider.register();
  return { tracer: trace.getTracer('ai-business-operator', '0.1.0'), shutdown: () => provider.shutdown() };
}

function applyLlmResult(span: Span, result: unknown): void {
  const r = result as {
    usage?: { inputTokens?: number; outputTokens?: number };
    model?: string;
    stopReason?: string;
    ok?: boolean;
    errorMessage?: string | null;
  };
  if (r?.usage !== undefined) {
    span.setAttribute('gen_ai.usage.input_tokens', r.usage.inputTokens ?? 0);
    span.setAttribute('gen_ai.usage.output_tokens', r.usage.outputTokens ?? 0);
    if (r.model !== undefined) span.setAttribute('gen_ai.response.model', r.model);
    if (r.stopReason !== undefined) span.setAttribute('gen_ai.response.finish_reasons', [r.stopReason]);
  }
  if (r?.ok === false) span.setStatus({ code: SpanStatusCode.ERROR, message: r.errorMessage ?? 'tool error' });
}

export function createTelemetry(tracer: Tracer, metrics: Metrics): Telemetry {
  return {
    async span<T>(
      name: string,
      attributes: Record<string, string | number | boolean>,
      fn: () => Promise<T>,
    ): Promise<T> {
      return tracer.startActiveSpan(name, { attributes }, async (span) => {
        try {
          const result = await fn();
          applyLlmResult(span, result);
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
          span.setAttribute('error.type', (error as Error).name);
          throw error;
        } finally {
          span.end();
        }
      });
    },
    llmCall(info) {
      metrics.llmCalls.inc({
        model: info.model,
        provider: info.provider,
        outcome: info.error === undefined ? 'ok' : 'error',
      });
      if (info.error !== undefined) return;
      metrics.llmTokens.inc({ model: info.model, direction: 'input' }, info.inputTokens);
      metrics.llmTokens.inc({ model: info.model, direction: 'output' }, info.outputTokens);
      metrics.llmCost.inc({ model: info.model }, info.costUsd);
      metrics.llmLatency.observe({ model: info.model }, info.latencyMs / 1000);
    },
    toolCall(info) {
      metrics.toolCalls.inc({ tool: info.tool, decision: info.decision, outcome: info.ok ? 'ok' : 'error' });
      if (info.decision === 'deny') metrics.blocked.inc({ rule: info.ruleId, tool: info.tool });
      if (info.decision === 'require_approval') metrics.proposals.inc({ tool: info.tool });
    },
  };
}

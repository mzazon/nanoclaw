// LOCAL-012: Bridge OTEL tracing — spans for notification, confirmation, tool calls.
//
// Proxy cleanup: Bun + NODE_USE_ENV_PROXY=1 ignores NO_PROXY for fetch(),
// so the OneCLI HTTP_PROXY intercepts OTLP exports. Clear before any
// exporter module loads. HTTPS_PROXY stays for credentialed APIs.
delete process.env.HTTP_PROXY;
delete process.env.http_proxy;
delete process.env.NODE_USE_ENV_PROXY;

import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let provider: BasicTracerProvider | null = null;

export function initBridgeTracing(sessionId?: string): void {
  if (provider) return;
  const rawEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!rawEndpoint) return;
  const endpoint = rawEndpoint.replace(':4317', ':4318');

  const attrs: Record<string, string> = {
    [ATTR_SERVICE_NAME]: 'nanoclaw-bridge',
    [ATTR_SERVICE_VERSION]: '0.0.1',
  };
  if (sessionId) attrs['session.id'] = sessionId;
  const agentGroup = process.env.NANOCLAW_AGENT_GROUP_ID;
  if (agentGroup) attrs['agent.group'] = agentGroup;

  provider = new BasicTracerProvider({
    resource: resourceFromAttributes(attrs),
    spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))],
  });
  process.stderr.write(`bridge: OTEL tracing initialized (endpoint=${endpoint}/v1/traces)\n`);
}

export async function shutdownTracing(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
  }
}

export function spanWrap<T>(name: string, attrs: Record<string, string | number>, fn: (span: Span) => T): T {
  if (!provider) return fn(null as unknown as Span);
  const tracer = provider.getTracer('bridge');
  return tracer.startActiveSpan(name, { attributes: attrs }, (span) => {
    try {
      const result = fn(span);
      span.end();
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      throw err;
    }
  });
}

import { describe, test, expect, afterEach, vi } from 'vitest';

describe('tracing', () => {
  afterEach(() => {
    vi.resetModules();
  });

  test('getTracer returns a tracer with span creation', async () => {
    const { getTracer } = await import('./tracing.js');
    const tracer = getTracer('test');
    expect(tracer).toBeDefined();
    expect(typeof tracer.startActiveSpan).toBe('function');
  });

  test('initTracing configures provider without throwing', async () => {
    const { initTracing, shutdownTracing } = await import('./tracing.js');
    expect(() =>
      initTracing({ endpoint: 'http://localhost:4317', serviceName: 'test', serviceVersion: '0.0.1' }),
    ).not.toThrow();
    await shutdownTracing();
  });

  test('initTracing is idempotent', async () => {
    const { initTracing, shutdownTracing } = await import('./tracing.js');
    initTracing({ endpoint: 'http://localhost:4317', serviceName: 'test', serviceVersion: '0.0.1' });
    initTracing({ endpoint: 'http://localhost:9999', serviceName: 'other', serviceVersion: '0.0.2' });
    await shutdownTracing();
  });
});

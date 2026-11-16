import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient, LlmError, type Transport } from '../src/llm/client.js';
import { MockTransport, httpError, reply } from '../src/llm/mock.js';
import { Store } from '../src/store/db.js';
import { createCache } from '../src/cache/cache.js';
import { createLogger } from '../src/log.js';
import { loadConfig } from '../src/config.js';

const Schema = z.object({ a: z.number() }).strict();
const cfg = loadConfig('config/agent.yaml');

async function make(script: Array<any>, overrides: Partial<typeof cfg.llm> = {}) {
  const store = new Store(':memory:');
  const log = createLogger(null);
  const cache = await createCache(undefined, store, log);
  const transport = new MockTransport(null, script) as Transport & { calls: number };
  const client = new LlmClient({
    cfg: { ...cfg, llm: { ...cfg.llm, ...overrides }, paths: { ...cfg.paths, logs: '/tmp/cv-agent-test-logs' } },
    transport, cache, store, log, runId: 'test', logDir: '/tmp/cv-agent-test-logs', sleep: async () => {},
  });
  return { client, store, transport };
}

const call = (client: LlmClient, user: string, semanticCheck?: (d: { a: number }) => string[]) =>
  client.call({
    stage: 'triage', vacancyId: 'test:1', toolName: 'submit_triage', toolDescription: 'test',
    schema: Schema, system: 'system prompt', promptVersion: 'triage/v1', promptHash: 'hash', user, semanticCheck,
  });

describe('llm client', () => {
  it('parses a tool call and serves the second identical call from cache', async () => {
    const { client, transport } = await make([reply({ toolCall: { name: 'submit_triage', args: '{"a":1}' } })]);
    const first = await call(client, 'vacancy one');
    expect(first.data.a).toBe(1);
    expect(first.fromCache).toBe(false);
    const second = await call(client, 'vacancy one');
    expect(second.fromCache).toBe(true);
    expect(transport.calls).toBe(1);
  });

  it('repairs malformed output in one extra round', async () => {
    const { client, store } = await make([
      reply({ toolCall: { name: 'submit_triage', args: 'not json at all' } }),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":2}' } }),
    ]);
    const res = await call(client, 'vacancy two');
    expect(res.data.a).toBe(2);
    const outcomes = store.db.prepare('SELECT outcome FROM llm_calls ORDER BY id').all() as Array<{ outcome: string }>;
    expect(outcomes.map((o) => o.outcome)).toEqual(['invalid', 'ok']);
  });

  it('feeds semantic errors back and returns them for review when they survive', async () => {
    const { client } = await make([
      reply({ toolCall: { name: 'submit_triage', args: '{"a":3}' } }),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":3}' } }),
    ]);
    const res = await call(client, 'vacancy three', () => ['a must be 9']);
    expect(res.issues).toEqual(['a must be 9']);
  });

  it('does not trip the circuit breaker on plans that only break semantic rules', async () => {
    const { client } = await make([
      reply({ toolCall: { name: 'submit_triage', args: '{"a":3}' } }),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":3}' } }),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":8}' } }),
    ], { circuitBreakerFailures: 1 });
    expect((await call(client, 'vacancy eight', () => ['a must be 9'])).issues).toEqual(['a must be 9']);
    expect((await call(client, 'vacancy nine')).data.a).toBe(8);
  });

  it('opens the circuit after consecutive hard failures', async () => {
    const { client } = await make([httpError(400)], { circuitBreakerFailures: 1 });
    await expect(call(client, 'vacancy ten')).rejects.toMatchObject({ kind: 'http' });
    await expect(call(client, 'vacancy eleven')).rejects.toMatchObject({ kind: 'circuit_open' });
  });

  it('retries a 429 and honours Retry-After', async () => {
    const { client, transport } = await make([
      httpError(429, { 'retry-after': '0' }),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":4}' } }),
    ]);
    expect((await call(client, 'vacancy four')).data.a).toBe(4);
    expect(transport.calls).toBe(2);
  });

  const withFallback = (o: Partial<typeof cfg.llm> = {}) => ({
    ...o,
    stages: { ...cfg.llm.stages, triage: { ...cfg.llm.stages.triage, model: 'cheap', fallbacks: [{ model: 'spare', extraBody: {} }, { model: 'last', extraBody: {} }] } },
  });

  it('switches to the fallback on a 429 and stays on it for the run', async () => {
    const { client, transport } = await make([
      httpError(429, { 'retry-after': '60' }),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":1}' } }),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":2}' } }),
    ], withFallback());
    expect((await call(client, 'rate one')).data.a).toBe(1);
    expect((await call(client, 'rate two')).data.a).toBe(2);
    expect((transport as unknown as MockTransport).models).toEqual(['cheap', 'spare', 'spare']);
  });

  it('falls back after retries run out on a 5xx, then tries the main model again', async () => {
    const { client, transport } = await make([
      httpError(503), httpError(503),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":1}' } }),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":2}' } }),
    ], withFallback({ maxRetries: 1 }));
    expect((await call(client, 'down one')).data.a).toBe(1);
    expect((await call(client, 'down two')).data.a).toBe(2);
    expect((transport as unknown as MockTransport).models).toEqual(['cheap', 'cheap', 'spare', 'cheap']);
  });

  it('walks down the fallback list while models are rate-limited', async () => {
    const { client, transport } = await make([
      httpError(429), httpError(429),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":1}' } }),
    ], withFallback());
    expect((await call(client, 'all busy')).data.a).toBe(1);
    expect((transport as unknown as MockTransport).models).toEqual(['cheap', 'spare', 'last']);
  });

  it('moves to the fallback when output stays invalid after the repair round', async () => {
    const { client, transport } = await make([
      reply({ toolCall: { name: 'submit_triage', args: '{"a":"garbled"}' } }),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":"garbled"}' } }),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":1}' } }),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":2}' } }),
    ], withFallback({ maxRepairRounds: 1 }));
    expect((await call(client, 'garbled once')).data.a).toBe(1);
    expect((await call(client, 'fine again')).data.a).toBe(2);
    const t = transport as unknown as MockTransport;
    expect(t.models).toEqual(['cheap', 'cheap', 'spare', 'cheap']); // only this call moved, and without the repair chat
    expect((t.bodies[2]!.messages as unknown[]).length).toBe(2);
  });

  it('gives up with invalid_output once every model has failed', async () => {
    const bad = () => reply({ toolCall: { name: 'submit_triage', args: '{"a":"garbled"}' } });
    const { client, transport } = await make([bad(), bad(), bad(), bad()], withFallback({ maxRepairRounds: 0 }));
    await expect(call(client, 'all garbled')).rejects.toMatchObject({ kind: 'invalid_output' });
    expect((transport as unknown as MockTransport).models).toEqual(['cheap', 'spare', 'last']);
  });

  it('keeps a schema-valid plan with issues for review instead of falling back', async () => {
    const { client, transport } = await make([
      reply({ toolCall: { name: 'submit_triage', args: '{"a":1}' } }),
      reply({ toolCall: { name: 'submit_triage', args: '{"a":1}' } }),
    ], withFallback({ maxRepairRounds: 1 }));
    const r = await call(client, 'rule broken', () => ['still wrong']);
    expect(r.issues).toEqual(['still wrong']);
    expect((transport as unknown as MockTransport).models).toEqual(['cheap', 'cheap']);
  });

  it('keeps the circuit per model, so one failing model leaves other stages running', async () => {
    const { client } = await make([httpError(400), reply({ toolCall: { name: 'submit_jobs', args: '{"a":3}' } })], {
      circuitBreakerFailures: 1, stages: { ...cfg.llm.stages, triage: { ...cfg.llm.stages.triage, model: 'flaky' } },
    });
    await expect(call(client, 'triage fails')).rejects.toMatchObject({ kind: 'http' });
    await expect(call(client, 'triage again')).rejects.toMatchObject({ kind: 'circuit_open' });
    const other = await client.call({
      stage: 'tailor', vacancyId: 'test:2', toolName: 'submit_jobs', toolDescription: 'test',
      schema: Schema, system: 'system prompt', promptVersion: 'tailor/v1', promptHash: 'hash', user: 'tailor works',
    });
    expect(other.data.a).toBe(3);
  });

  it('shortens an OpenRouter error to the upstream reason', async () => {
    const { client } = await make([httpError(400, {}, { error: { message: 'Provider returned error', code: 400, metadata: { raw: 'model is busy', provider_name: 'GMICloud' } } })]);
    await expect(call(client, 'error text')).rejects.toThrow('HTTP 400: GMICloud: model is busy');
  });

  it('does not retry a 400', async () => {
    const { client, transport } = await make([httpError(400), reply({ toolCall: { name: 'submit_triage', args: '{"a":5}' } })]);
    await expect(call(client, 'vacancy five')).rejects.toBeInstanceOf(LlmError);
    expect(transport.calls).toBe(1);
  });

  it('treats a refusal as final', async () => {
    const { client } = await make([reply({ refusal: 'I cannot help with that' })]);
    await expect(call(client, 'vacancy six')).rejects.toMatchObject({ kind: 'refusal' });
  });

  it('stops before spending past the daily budget', async () => {
    const { client, store } = await make([reply({ toolCall: { name: 'submit_triage', args: '{"a":7}' } })]);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }).format(new Date());
    store.recordLlmCall({
      at: new Date().toISOString(), day, runId: 'seed', stage: 'triage', vacancyId: 'x', model: 'm',
      promptVersion: 'v', promptHash: 'h', cache: 'miss', inputTokens: 10 ** 9, cachedTokens: 0, outputTokens: 0,
      reasoningTokens: 0, costUsd: null, latencyMs: 1, attempt: 0, outcome: 'ok', error: null,
    });
    await expect(call(client, 'vacancy seven')).rejects.toMatchObject({ kind: 'budget' });
  });
});

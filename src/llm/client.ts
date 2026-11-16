import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Cache } from '../cache/cache.js';
import type { Store } from '../store/db.js';
import { appendJsonl, type Logger } from '../log.js';
import { sha256, stableStringify } from '../util/hash.js';
import { parseRetryAfter, sleep as realSleep, withRetry } from '../util/retry.js';
import { localDay } from '../util/time.js';

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface Msg { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface TransportResponse { status: number; headers: Headers; json: any }
export interface Transport { send(body: Record<string, unknown>, timeoutMs: number): Promise<TransportResponse> }

/** Any OpenAI-compatible /chat/completions endpoint: OpenRouter, Xiaomi's MiMo platform, a local gateway. */
export class HttpTransport implements Transport {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}
  async send(body: Record<string, unknown>, timeoutMs: number): Promise<TransportResponse> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = { unparsed: text.slice(0, 2000) }; }
    return { status: res.status, headers: res.headers, json };
  }
}

export type LlmErrorKind = 'http' | 'network' | 'timeout' | 'invalid_output' | 'refusal' | 'budget' | 'circuit_open';
export class LlmError extends Error {
  constructor(readonly kind: LlmErrorKind, message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'LlmError';
  }
}
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export interface StructuredCall<T> {
  stage: 'triage' | 'tailor' | 'extract' | 'answer';
  vacancyId: string;
  toolName: string;
  toolDescription: string;
  schema: z.ZodType<T>;
  system: string;
  promptVersion: string;
  promptHash: string;
  user: string;
  /** Rules the schema can't express (grounding, CV format). Returned strings are fed back for one repair round. */
  semanticCheck?: (data: T) => string[];
  /** Tidies shapes a model gets slightly wrong before validation — free, where a repair round is a paid call. */
  coerce?: (raw: unknown) => unknown;
}
export interface CallResult<T> { data: T; issues: string[]; fromCache: boolean }

interface Usage { input: number; output: number; cached: number; reasoning: number; providerCost: number | null }
const ZERO: Usage = { input: 0, output: 0, cached: 0, reasoning: 0, providerCost: null };
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function normUsage(u: any): Usage {
  return {
    input: num(u?.prompt_tokens ?? u?.input_tokens),
    output: num(u?.completion_tokens ?? u?.output_tokens),
    cached: num(u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? u?.cache_read_input_tokens),
    reasoning: num(u?.completion_tokens_details?.reasoning_tokens),
    providerCost: typeof u?.cost === 'number' ? u.cost : null,
  };
}

export class LlmClient {
  /** Consecutive hard failures per stage model: one rate-limited model must not stop stages that run on another. */
  private readonly failures = new Map<string, number>();
  /** Models that answered 429: skipped for the rest of the run while the stage has another model to try. */
  private readonly limited = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: {
    cfg: Config; transport: Transport; cache: Cache; store: Store; log: Logger;
    runId: string; logDir: string; sleep?: (ms: number) => Promise<void>;
  }) {
    this.sleep = o.sleep ?? realSleep;
  }

  async call<T>(c: StructuredCall<T>): Promise<CallResult<T>> {
    const { cfg, cache, log } = this.o;
    const stage = cfg.llm.stages[c.stage];
    const params = z.toJSONSchema(c.schema) as Record<string, unknown>;
    delete params.$schema;
    const tool = { type: 'function', function: { name: c.toolName, description: c.toolDescription, parameters: params } };
    const base = { stage: c.stage, vacancyId: c.vacancyId, model: stage.model, promptVersion: c.promptVersion, promptHash: c.promptHash };
    const key = `cvagent:llm:${c.stage}:${sha256(stableStringify({
      host: hostOf(cfg.llm.baseUrl), model: stage.model, prompt: c.promptHash,
      schema: sha256(JSON.stringify(params)), user: c.user, t: stage.temperature, x: stage.extraBody,
    }))}`;

    const cached = await cache.get(key);
    if (cached !== null) {
      const parsed = safeJson(cached);
      const v = parsed === undefined ? null : c.schema.safeParse(parsed);
      if (v?.success && (c.semanticCheck?.(v.data) ?? []).length === 0) {
        this.record({ ...base, cache: 'hit', usage: ZERO, cost: 0, latencyMs: 0, attempt: 0, outcome: 'ok', error: null });
        return { data: v.data, issues: [], fromCache: true };
      }
    }

    this.guard(stage.model);
    this.savePrompt(c.promptHash, c.system);
    const messages: Msg[] = [{ role: 'system', content: c.system }, { role: 'user', content: c.user }];
    let last: { data?: T; issues: string[] } = { issues: [] };
    let from = 0; // the first route to try: moves past a model whose output stayed invalid
    let route = 0;

    for (let round = 0; ; round++) {
      const body = {
        messages, tools: [tool],
        tool_choice: toolChoice(cfg.llm.toolChoice, c.toolName),
        temperature: stage.temperature, max_tokens: stage.maxTokens, stream: false,
      };
      const started = Date.now();
      let resp: TransportResponse;
      try {
        ({ resp, model: base.model, route } = await this.send(stage, body, base, from));
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmError('network', String(e));
        this.fail(stage.model);
        this.record({ ...base, cache: 'miss', usage: ZERO, cost: null, latencyMs: Date.now() - started, attempt: round, outcome: err.kind, error: err.message.slice(0, 500) });
        this.jsonl({ ...base, round, decision: err.kind, error: err.message });
        throw err;
      }

      const latencyMs = Date.now() - started;
      const usage = normUsage(resp.json?.usage);
      const cost = this.cost(usage);
      const choice = resp.json?.choices?.[0];
      const extracted = extract(choice?.message, c.toolName);

      if (extracted.refusal) {
        this.fail(stage.model);
        this.record({ ...base, cache: 'miss', usage, cost, latencyMs, attempt: round, outcome: 'refusal', error: extracted.refusal.slice(0, 500) });
        this.jsonl({ ...base, round, user: round === 0 ? c.user : undefined, raw: resp.json, decision: 'refusal' });
        throw new LlmError('refusal', extracted.refusal);
      }

      const issues: string[] = [];
      let data: T | undefined;
      let schemaOk = false;
      if (choice?.finish_reason === 'length') issues.push('the answer was cut off at max_tokens — be more concise');
      if (extracted.args === undefined) issues.push(`no ${c.toolName} call found — return the result by calling ${c.toolName}`);
      else {
        const obj = safeJson(extracted.args);
        if (obj === undefined) issues.push('tool arguments were not valid JSON');
        else {
          const v = c.schema.safeParse(c.coerce ? c.coerce(obj) : obj);
          if (!v.success) issues.push(...v.error.issues.slice(0, 15).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
          else { schemaOk = true; data = v.data; issues.push(...(c.semanticCheck?.(v.data) ?? [])); }
        }
      }

      const outcome = schemaOk && issues.length === 0 ? 'ok' : schemaOk ? 'semantic_issues' : 'invalid';
      this.record({ ...base, cache: 'miss', usage, cost, latencyMs, attempt: round, outcome, error: issues.length ? issues.join(' | ').slice(0, 1000) : null });
      this.jsonl({ ...base, round, user: round === 0 ? c.user : undefined, raw: resp.json, issues, decision: outcome });

      if (outcome === 'ok' && data !== undefined) {
        this.failures.delete(stage.model);
        await cache.set(key, JSON.stringify(data), Math.round(cfg.cache.ttlDays[c.stage] * 86_400));
        return { data, issues: [], fromCache: false };
      }

      last = { data: schemaOk ? data : undefined, issues };
      if (round < cfg.llm.maxRepairRounds) {
        const fix = `Your ${c.toolName} call failed validation:\n- ${issues.join('\n- ')}\nCall ${c.toolName} again with every problem fixed. Use only facts that are already in the fact base.`;
        if (extracted.toolCall) messages.push({ role: 'assistant', content: null, tool_calls: [extracted.toolCall] }, { role: 'tool', tool_call_id: extracted.toolCall.id, content: fix });
        else messages.push({ role: 'assistant', content: (extracted.content ?? '').slice(0, 4000) || '(empty)' }, { role: 'user', content: fix });
        continue;
      }
      if (last.data !== undefined || route >= stage.fallbacks.length) break;

      // Repair rounds can't mend a model or host that garbles its tool calls (it copies the broken call back), so the
      // next model starts over from the original messages. Schema-valid output never gets here: a person reviews that.
      log.warn({ ...base, issues: issues.slice(0, 3), fallback: stage.fallbacks[route]!.model }, 'llm output still invalid; trying the fallback');
      this.guard(stage.model);
      from = route + 1;
      round = -1;
      messages.length = 2;
    }

    // Schema-valid but still breaking a rule: hand it back so the caller can park it for human review.
    // The endpoint answered properly, so this is not a failure for the circuit breaker.
    if (last.data !== undefined) {
      this.failures.delete(stage.model);
      return { data: last.data, issues: last.issues, fromCache: false };
    }
    this.fail(stage.model);
    throw new LlmError('invalid_output', last.issues.join(' | ') || 'invalid output');
  }

  /**
   * The stage's model, then its fallbacks in order. A 429 with another model left isn't waited out (upstream limits
   * often last minutes, and Retry-After asked for 60 s per attempt): the next model is used, here and for the rest of the run.
   * `from` skips the models already given up on for this call.
   */
  private async send(stage: Config['llm']['stages']['triage'], body: Record<string, unknown>, base: Record<string, unknown>, from: number): Promise<{ resp: TransportResponse; model: string; route: number }> {
    const { cfg, log } = this.o;
    const routes = [{ model: stage.model, extraBody: stage.extraBody }, ...stage.fallbacks];
    for (const [i, r] of routes.entries()) {
      const next = routes[i + 1];
      if (i < from || (next && this.limited.has(r.model))) continue;
      try {
        const resp = await withRetry(() => this.sendOnce({ ...body, model: r.model, ...r.extraBody }), {
          retries: cfg.llm.maxRetries,
          deadlineMs: cfg.llm.timeoutMs * 3,
          sleep: this.sleep,
          isRetryable: (e) => retryable(e) && !(next && rateLimited(e)),
          retryAfterMs: (e) => (e instanceof LlmError ? e.retryAfterMs : undefined),
          onRetry: (e, attempt, delayMs) => log.warn({ ...base, model: r.model, attempt, delayMs, err: (e as Error).message }, 'llm retry'),
        });
        return { resp, model: r.model, route: i };
      } catch (e) {
        if (!next || !retryable(e)) throw e;
        if (rateLimited(e) && !this.limited.has(r.model)) {
          this.limited.add(r.model);
          log.warn({ ...base, model: r.model, fallback: next.model, err: (e as Error).message }, 'llm model rate-limited; using the fallback for the rest of this run');
        } else log.warn({ ...base, model: r.model, fallback: next.model, err: (e as Error).message }, 'llm falling back');
      }
    }
    throw new LlmError('network', 'no model left to try'); // unreachable: the last route throws
  }

  private fail(model: string): void {
    this.failures.set(model, (this.failures.get(model) ?? 0) + 1);
  }

  private async sendOnce(body: Record<string, unknown>): Promise<TransportResponse> {
    let r: TransportResponse;
    try {
      r = await this.o.transport.send(body, this.o.cfg.llm.timeoutMs);
    } catch (e) {
      const name = (e as Error)?.name;
      throw new LlmError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', (e as Error)?.message ?? String(e));
    }
    if (r.status >= 400) {
      throw new LlmError('http', `HTTP ${r.status}: ${errorText(r.json)}`, r.status, parseRetryAfter(r.headers.get('retry-after')));
    }
    return r;
  }

  private guard(model: string): void {
    const { cfg, store } = this.o;
    const failures = this.failures.get(model) ?? 0;
    if (failures >= cfg.llm.circuitBreakerFailures) {
      throw new LlmError('circuit_open', `${failures} consecutive failures on ${model} — not calling it again this run`);
    }
    const spend = store.spend(localDay(new Date(), cfg.timezone));
    if (spend.usd >= cfg.llm.budget.dailyUsd) throw new LlmError('budget', `daily budget reached ($${spend.usd.toFixed(3)} of $${cfg.llm.budget.dailyUsd})`);
    if (spend.tokens >= cfg.llm.budget.dailyTokens) throw new LlmError('budget', `daily token budget reached (${spend.tokens} of ${cfg.llm.budget.dailyTokens})`);
  }

  private cost(u: Usage): number | null {
    if (u.providerCost !== null) return u.providerCost;
    const p = this.o.cfg.llm.pricing;
    if (p.inputPerM === null || p.outputPerM === null) return null;
    return ((u.input - u.cached) * p.inputPerM + u.cached * (p.cachedInputPerM ?? p.inputPerM) + u.output * p.outputPerM) / 1e6;
  }

  private record(r: { stage: string; vacancyId: string; model: string; promptVersion: string; promptHash: string; cache: 'hit' | 'miss'; usage: Usage; cost: number | null; latencyMs: number; attempt: number; outcome: string; error: string | null }): void {
    const now = new Date();
    this.o.store.recordLlmCall({
      at: now.toISOString(), day: localDay(now, this.o.cfg.timezone), runId: this.o.runId,
      stage: r.stage, vacancyId: r.vacancyId, model: r.model, promptVersion: r.promptVersion, promptHash: r.promptHash,
      cache: r.cache, inputTokens: r.usage.input, cachedTokens: r.usage.cached, outputTokens: r.usage.output,
      reasoningTokens: r.usage.reasoning, costUsd: r.cost, latencyMs: r.latencyMs, attempt: r.attempt,
      outcome: r.outcome, error: r.error,
    });
    this.o.log.info({ stage: r.stage, vacancyId: r.vacancyId, cache: r.cache, in: r.usage.input, cachedIn: r.usage.cached, out: r.usage.output, costUsd: r.cost, ms: r.latencyMs, outcome: r.outcome }, 'llm call');
  }

  /** The system prompt is stored once per hash; call logs reference it instead of repeating it. */
  private savePrompt(hash: string, text: string): void {
    const dir = path.join(this.o.logDir, 'prompts');
    const file = path.join(dir, `${hash}.md`);
    if (!fs.existsSync(file)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, text); }
  }

  private jsonl(record: Record<string, unknown>): void {
    const now = new Date();
    appendJsonl(this.o.logDir, `${localDay(now, this.o.cfg.timezone)}.jsonl`, { at: now.toISOString(), runId: this.o.runId, ...record });
  }
}

function extract(msg: any, toolName: string): { args?: string; toolCall?: ToolCall; refusal?: string; content?: string } {
  if (!msg) return {};
  if (typeof msg.refusal === 'string' && msg.refusal.trim()) return { refusal: msg.refusal };
  const calls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const tc = calls.find((t) => t?.function?.name === toolName) ?? calls[0];
  if (tc?.function) {
    const args = typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {});
    return { args, toolCall: { id: String(tc.id ?? 'call_0'), type: 'function', function: { name: String(tc.function.name), arguments: args } } };
  }
  const content = typeof msg.content === 'string' ? msg.content : '';
  return { args: /\{[\s\S]*\}/.exec(content.replace(/```(?:json)?/g, ''))?.[0], content };
}

const retryable = (e: unknown): boolean => e instanceof LlmError && (e.kind === 'timeout' || e.kind === 'network' || (e.kind === 'http' && RETRYABLE.has(e.status ?? 0)));
const rateLimited = (e: unknown): boolean => e instanceof LlmError && e.kind === 'http' && e.status === 429;
/** OpenRouter wraps the upstream reason in error.metadata.raw; the JSON around it only buries it. */
function errorText(json: any): string {
  const err = json?.error;
  const text = typeof err?.metadata?.raw === 'string' ? err.metadata.raw : typeof err?.message === 'string' ? err.message : JSON.stringify(json);
  return [err?.metadata?.provider_name, text].filter(Boolean).join(': ').slice(0, 300);
}
const toolChoice = (mode: 'forced' | 'required' | 'auto', name: string): unknown => (mode === 'forced' ? { type: 'function', function: { name } } : mode);
const safeJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };
const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return u; } };

import fs from 'node:fs';
import path from 'node:path';
import type { Msg, Transport, TransportResponse } from './client.js';

export type Scripted = TransportResponse | Error;

/** Offline transport: scripted replies for tests, fixture files for the demo run. */
export class MockTransport implements Transport {
  calls = 0;
  constructor(private readonly dir: string | null, private readonly script: Scripted[] = []) {}

  async send(body: Record<string, unknown>): Promise<TransportResponse> {
    this.calls++;
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (next) return next;

    const b = body as any;
    const toolName = b.tools?.[0]?.function?.name as string | undefined;
    const stage = toolName === 'submit_triage' ? 'triage' : toolName === 'submit_jobs' ? 'extract' : toolName === 'submit_answers' ? 'answer' : 'tailor';
    const user = (b.messages as Msg[]).find((m) => m.role === 'user')?.content ?? '';
    const id = /<(?:vacancy|email|form) id="([^"]+)"/.exec(user ?? '')?.[1] ?? 'unknown';
    const promptTokens = Math.ceil(JSON.stringify(b.messages).length / 4);
    const file = this.dir ? path.join(this.dir, `${id.replace(/[^a-z0-9]+/gi, '_')}.${stage}.json`) : '';
    if (!file || !fs.existsSync(file)) return reply({ content: `mock: no fixture for ${id} (${stage})` }, promptTokens, 12);
    const args = fs.readFileSync(file, 'utf8');
    return reply({ toolCall: { name: toolName ?? 'unknown', args } }, promptTokens, Math.ceil(args.length / 4));
  }
}

export function reply(
  m: { toolCall?: { name: string; args: string }; content?: string; refusal?: string; finish?: string },
  promptTokens = 100,
  completionTokens = 20,
  headers: Record<string, string> = {},
): TransportResponse {
  const message = m.toolCall
    ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_mock', type: 'function', function: { name: m.toolCall.name, arguments: m.toolCall.args } }] }
    : { role: 'assistant', content: m.content ?? null, refusal: m.refusal ?? null };
  return {
    status: 200,
    headers: new Headers(headers),
    json: {
      choices: [{ finish_reason: m.finish ?? (m.toolCall ? 'tool_calls' : 'stop'), message }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, prompt_tokens_details: { cached_tokens: 0 } },
    },
  };
}

export const httpError = (status: number, headers: Record<string, string> = {}): TransportResponse =>
  ({ status, headers: new Headers(headers), json: { error: { message: `mock ${status}` } } });

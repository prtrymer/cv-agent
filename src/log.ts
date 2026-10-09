import fs from 'node:fs';
import path from 'node:path';
import { destination, multistream, pino, stdTimeFunctions, type Logger } from 'pino';

export type { Logger };

const REDACT = ['apiKey', '*.apiKey', 'authorization', '*.authorization', 'headers.authorization', 'password', '*.password'];

/** Structured logs: stdout at LOG_LEVEL (warn: problems only — progress is printed by the CLI) plus a full debug log file. `logsDir: null` = silent (tests). */
export function createLogger(logsDir: string | null, level = process.env.LOG_LEVEL ?? 'warn'): Logger {
  const opts = { level: 'debug', base: undefined, timestamp: stdTimeFunctions.isoTime, redact: { paths: REDACT, censor: '[redacted]' } };
  if (!logsDir) return pino({ ...opts, level: 'silent' });
  fs.mkdirSync(logsDir, { recursive: true });
  return pino(opts, multistream([
    { level: level as any, stream: process.stdout },
    { level: 'debug' as any, stream: destination({ dest: path.join(logsDir, 'agent.log'), sync: true }) },
  ]));
}

export function appendJsonl(dir: string, file: string, record: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, file), JSON.stringify(record) + '\n');
}

import { createInterface } from 'node:readline/promises';
import type { Field } from './scan.js';

/** How the apply step talks to you: questions it can't answer, and "tell me when the form is on screen". */
export interface Asker {
  /** Your answer, or null to leave the field for you to fill in the browser. */
  question(f: Field): Promise<string | null>;
  pause(message: string): Promise<void>;
  /** A link (or email address) you paste after doing something in your own browser; null = cancel. */
  link(message: string): Promise<string | null>;
  close(): void;
}

/** Questions in the terminal. Without a terminal (cron, CI) nothing is asked and the fields stay for you. */
export function terminalAsker(): Asker {
  if (!process.stdin.isTTY) return { question: async () => null, pause: async () => {}, link: async () => null, close: () => {} };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async question(f) {
      const opts = f.options.length ? `\n${f.options.map((o, i) => `    ${i + 1}) ${o}`).join('\n')}` : '';
      const raw = (await rl.question(`\n  ? ${f.label}${f.required ? ' (required)' : ''}${opts}\n  > `)).trim();
      if (!raw) return null;
      const n = Number(raw);
      return f.options.length && Number.isInteger(n) && n >= 1 && n <= f.options.length ? f.options[n - 1] : raw;
    },
    async pause(message) { await rl.question(`\n  ${message} `); },
    async link(message) { return (await rl.question(`\n  ${message}\n  (empty = cancel) > `)).trim() || null; },
    close() { rl.close(); },
  };
}

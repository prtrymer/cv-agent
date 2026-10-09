import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { ATS_KINDS, fetchBoard, type Board } from '../ats/boards.js';
import { findBoard } from '../ats/resolve.js';
import type { Ctx } from '../ctx.js';
import { titleCheck } from '../pipeline/prefilter.js';
import { canonicalize } from '../util/url.js';

const Entry = z.object({
  name: z.string().min(1),
  ats: z.enum(ATS_KINDS).optional(),
  board: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
}).strict().refine((e) => !e.ats === !e.board, { message: 'give both ats and board, or neither (then it is looked up)' });
export type WatchEntry = z.infer<typeof Entry>;

export function loadWatchlist(file: string | null): WatchEntry[] {
  if (!file || !fs.existsSync(file)) return [];
  const parsed = z.array(Entry).safeParse(YAML.parse(fs.readFileSync(file, 'utf8')) ?? []);
  if (!parsed.success) throw new Error(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data.filter((e) => e.enabled);
}

/** One watchlist company's open jobs that pass the title rules; a company without ats/board is looked up first. */
export async function readCompany(ctx: Ctx, e: WatchEntry): Promise<Board> {
  const ref = e.ats && e.board
    ? { ats: e.ats, board: e.board }
    : await findBoard(e.name, ctx.store, ctx.cfg.http, ctx.cfg.ats.probeTtlDays, ctx.now());
  if (!ref) throw new Error(`no public job board found on ${ATS_KINDS.join(', ')} — add ats and board by hand, or disable it`);
  const board = await fetchBoard(ref, ctx.cfg.http, {
    keep: (title) => titleCheck(title, ctx.cfg.prefilter).pass,
    known: (url) => { const c = canonicalize(url); return Boolean(c && ctx.store.get(c.key)); },
  });
  board.jobs = board.jobs.map((j) => ({ ...j, company: j.company ?? board.company ?? e.name }));
  return board;
}

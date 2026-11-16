import type { Config } from '../config.js';

export interface AlertMail { id: string; from: string; subject: string; date: string | null; html: string; text: string }

/** Where alert emails come from: IMAP in real runs, a list in tests. `known(id)` emails are skipped undownloaded. */
export interface MailSource { fetch(since: Date, known?: (id: string) => boolean): Promise<AlertMail[]> }

/**
 * Gmail (or any IMAP server), strictly read-only: the mailbox is opened with EXAMINE, so nothing is marked read,
 * moved or deleted. Only messages from the configured alert senders are downloaded.
 */
export class ImapMailSource implements MailSource {
  constructor(private readonly cfg: Config['alerts']) {}

  async fetch(since: Date, known: (id: string) => boolean = () => false): Promise<AlertMail[]> {
    const user = process.env[this.cfg.userEnv]?.trim();
    const pass = process.env[this.cfg.passwordEnv]?.replace(/\s+/g, ''); // Google shows app passwords in groups of 4
    if (!user || !pass) throw new Error(`alerts: set ${this.cfg.userEnv} and ${this.cfg.passwordEnv} in .env (for Gmail, an app password)`);
    const { ImapFlow } = await import('imapflow');
    const { simpleParser } = await import('mailparser');
    const client = new ImapFlow({ host: this.cfg.host, port: this.cfg.port, secure: true, auth: { user, pass }, logger: false });
    try {
      await client.connect();
    } catch (e) {
      client.close(); // an unclosed socket would keep the process alive after the error
      const err = e as { authenticationFailed?: boolean; responseText?: string; message: string };
      if (err.authenticationFailed) {
        throw new Error(`alerts: ${this.cfg.host} rejected ${this.cfg.userEnv}/${this.cfg.passwordEnv} (${err.responseText ?? 'invalid credentials'}). `
          + 'For Gmail: the app password must be created while signed in to that same account (myaccount.google.com/apppasswords), with 2-Step Verification on');
      }
      throw new Error(`alerts: could not connect to ${this.cfg.host}: ${err.responseText ?? err.message}`);
    }
    const out: AlertMail[] = [];
    try {
      const lock = await client.getMailboxLock(this.cfg.mailbox, { readOnly: true });
      try {
        const senders = this.cfg.senders.map((from) => ({ from }));
        const query = senders.length === 1 ? { since, ...senders[0] } : { since, or: senders };
        const found = (await client.search(query, { uid: true })) || [];
        if (found.length === 0) return out;
        // Envelopes first (a few hundred bytes each): emails read on earlier runs are never downloaded again.
        const uids: number[] = [];
        for await (const msg of client.fetch(found, { uid: true, envelope: true }, { uid: true })) {
          if (!known(msg.envelope?.messageId ?? `uid:${msg.uid}`)) uids.push(msg.uid);
        }
        if (uids.length === 0) return out;
        for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
          if (!msg.source) continue;
          const m = await simpleParser(msg.source);
          out.push({
            id: m.messageId ?? `uid:${msg.uid}`,
            from: m.from?.value?.[0]?.address ?? '',
            subject: m.subject ?? '',
            date: m.date?.toISOString() ?? null,
            html: typeof m.html === 'string' ? m.html : '',
            text: m.text ?? '',
          });
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
    return out;
  }
}

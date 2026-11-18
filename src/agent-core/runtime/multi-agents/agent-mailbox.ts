import type { AgentMail, AgentMessagePurpose } from '../../../shared/agent/coordination.js';
import type { MailboxStore, MailFilter } from '../../repositories/agent-coordination-repository.js';
import type { Session } from '../workspace-store.js';
import type { AgentDirectory } from './agent-directory.js';

export type SendMailInput =
  | { kind: 'send'; to: string; subject: string; body: string; purpose: AgentMessagePurpose }
  | { kind: 'reply'; message?: string | undefined; body: string; purpose: AgentMessagePurpose };

export class AgentMailbox {
  constructor(private readonly store: MailboxStore, private readonly directory: AgentDirectory) {}

  async send(session: Session, input: SendMailInput, operation: string) {
    const prior = this.store.sentMail(session.id, operation);
    if (prior) return this.present(session, prior);
    const rootId = session.rootSessionId ?? session.id;
    if (input.kind === 'reply') {
      const original = input.message ? this.requireMessage(session, input.message) : this.uniqueUnansweredQuestion(session);
      if (original.toSessionId !== session.id) throw new Error('Reply to mail you received.');
      return this.present(session, this.store.sendMail({
        rootId, fromSessionId: session.id, toSessionId: original.fromSessionId, subject: original.subject,
        body: input.body, purpose: input.purpose, author: 'model', replyTo: original.id,
      }, operation));
    }
    const target = await this.directory.resolve(session, input.to);
    return this.present(session, this.store.sendMail({
      rootId, fromSessionId: session.id, toSessionId: target.id, subject: input.subject,
      body: input.body, purpose: input.purpose, author: 'model', replyTo: null,
    }, operation));
  }

  async search(session: Session, filter: MailFilter) {
    const from = filter.from && (await this.directory.resolve(session, filter.from)).id;
    const thread = filter.thread && this.requireMessage(session, filter.thread).threadId;
    return this.store.searchMail(session.id, { ...filter, from, thread }).map((mail) => this.present(session, mail));
  }

  read(session: Session, ref: string) {
    const mail = this.requireMessage(session, ref);
    this.store.readMail(session.id, mail.id);
    return this.present(session, this.requireMessage(session, ref));
  }

  requireMessage(session: Session, ref: string): AgentMail {
    const root = session.rootSessionId ?? session.id;
    const number = /^m#([1-9][0-9]*)$/.exec(ref)?.[1];
    const mail = this.store.mail(root, number ? Number(number) : ref);
    if (!mail || (mail.fromSessionId !== session.id && mail.toSessionId !== session.id)) throw new Error('Mail not found in your mailbox.');
    return mail;
  }

  present(session: Session, mail: AgentMail) {
    const thread = this.store.mail(mail.rootId, mail.threadId);
    const repliedTo = mail.replyTo && this.store.mail(mail.rootId, mail.replyTo);
    return {
      message: `m#${mail.number}`, from: this.directory.reference(session, mail.fromSessionId), to: this.directory.reference(session, mail.toSessionId),
      subject: mail.subject, body: mail.body, author: mail.author, purpose: mail.purpose, createdAt: mail.createdAt,
      unread: mail.toSessionId === session.id && mail.readAt === null, thread: `m#${thread?.number ?? mail.number}`,
      ...(repliedTo ? { replyTo: `m#${repliedTo.number}` } : {}),
    };
  }

  private uniqueUnansweredQuestion(session: Session): AgentMail {
    const questions = this.store.unansweredQuestions(session.id);
    if (questions.length !== 1) throw new Error('Specify which message to reply to.');
    return questions[0]!;
  }
}

import type { WhatsAppSender } from '../adapters/whatsapp/cloud.ts';
import { ingestWhatsAppText, isWhatsAppBindingActive, type WhatsAppDemoBinding } from '../adapters/whatsapp/intake.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../ports/logger.ts';
import { hasInternalReplyContent, MAX_REPLY_CHARS } from '../replies/ali-decision.ts';
import type { ReplyGenerator, ReplyTurn } from '../replies/reply-generator.ts';
import { blockedRuleForTurn, correctionFor, type ReplyGuardRule } from '../replies/reply-guard.ts';
import { currentTestMessageSql, readChatTestWindow } from '../services/chat-test-session.ts';
import { applyModeChange } from '../services/mode-change.ts';
import type { Db, Tx } from '../storage/db.ts';
import { record } from '../storage/repos/case-actions.ts';
import { findChatById } from '../storage/repos/chats.ts';
import { createJobLoop, type JobLoop } from './job-loop.ts';

interface Options {
  db: Db;
  binding: WhatsAppDemoBinding;
  config: Config;
  testerIds: readonly string[];
  generator: ReplyGenerator;
  sender: WhatsAppSender;
  logger: Logger;
  onReplyStored(): void;
}

interface Trigger {
  chatId: string;
  messageId: string;
  sourceId: string;
  peer: string;
  revision: number;
  evidencePosition: number;
  brief: string | null;
  sentAt: string;
  position: number;
}

const CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_HISTORY_TURNS = 48;

function nextTrigger(tx: Tx, options: Options, chatId: string | null = null): Trigger | undefined {
  const { binding, testerIds } = options;
  if (!isWhatsAppBindingActive(tx, binding)) return;
  const now = tx.now();
  // Choose the latest inbound by source time before testing its eligibility. A duplicate, late webhook or
  // already answered turn can never make an older message the next candidate.
  return tx.get<Trigger>(`SELECT c.id AS chatId, c.external_chat_id AS peer, c.revision, m.id AS messageId,
      m.source_message_id AS sourceId, m.sent_at AS sentAt, m.position, b.context AS brief,
      (SELECT max(e.position) FROM message_events e WHERE e.chat_id=c.id) AS evidencePosition
    FROM chats c JOIN messages m ON m.id = (
      SELECT i.id FROM messages i WHERE i.chat_id=c.id AND i.direction='incoming'
      ORDER BY i.sent_at DESC, i.position DESC LIMIT 1)
    LEFT JOIN dispatch_briefs b ON b.chat_id=c.id
    WHERE c.channel_account_id=:accountId AND c.workspace_id=:workspaceId AND c.ai_mode='ai_active'
      AND (:chatId IS NULL OR c.id=:chatId) AND c.external_chat_id IN (SELECT value FROM json_each(:testers))
      AND m.sender_external_id=c.external_chat_id AND m.capture_method='whatsapp_business_live'
      AND m.source_message_id IS NOT NULL AND length(trim(m.text))>0 AND m.original_captured=1
      AND m.edited_at_source=0 AND m.deleted_at_source=0 AND m.sent_at>:cutoff AND m.sent_at<=:now
      AND EXISTS (SELECT 1 FROM message_events e WHERE e.message_id=m.id AND e.type='recorded' AND e.connector_id=:connectorId)
      AND NOT EXISTS (SELECT 1 FROM message_events e WHERE e.message_id=m.id AND e.type='conflicting_copy')
      AND NOT EXISTS (SELECT 1 FROM case_actions a WHERE a.chat_id=c.id AND a.type='chat_test_started'
        AND (m.position<=a.position OR m.sent_at<a.occurred_at))
      AND NOT EXISTS (SELECT 1 FROM whatsapp_demo_opt_outs o WHERE o.chat_id=c.id)
      AND NOT EXISTS (SELECT 1 FROM whatsapp_reply_attempts a WHERE a.message_id=m.id)
      AND NOT EXISTS (SELECT 1 FROM whatsapp_reply_attempts a JOIN messages pending ON pending.id=a.message_id
        WHERE pending.chat_id=c.id AND a.state='sending' AND a.created_at>datetime('now','-2 minutes'))
      AND NOT EXISTS (SELECT 1 FROM case_actions a WHERE a.message_id=m.id AND a.type='leave_unanswered')
      AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.chat_id=c.id AND o.direction='outgoing'
        AND unixepoch(coalesce(o.sent_at,o.received_at))>=unixepoch(m.sent_at)
        AND NOT EXISTS (SELECT 1 FROM case_actions a WHERE a.message_id=o.id AND a.type='ai_reply_sent'))
    ORDER BY m.position, m.id LIMIT 1`, {
    chatId, accountId: binding.accountId, workspaceId: binding.workspaceId, connectorId: binding.connectorId,
    testers: JSON.stringify(testerIds), cutoff: new Date(Date.parse(now) - CUSTOMER_WINDOW_MS).toISOString(), now,
  });
}

function historyFor(tx: Tx, options: Options, job: Trigger): ReplyTurn[] {
  const window = readChatTestWindow(tx, job.chatId);
  return tx.all<ReplyTurn>(`SELECT CASE m.direction WHEN 'incoming' THEN 'contact' ELSE 'owner' END AS "from", m.text
    FROM messages m WHERE m.chat_id=:chatId AND m.capture_method='whatsapp_business_live'
      AND m.text IS NOT NULL AND m.original_captured=1 AND m.edited_at_source=0 AND m.deleted_at_source=0
      AND (m.sent_at,m.position)<=(:sentAt,:throughPosition) AND ${currentTestMessageSql}
      AND (:position=0 OR unixepoch(m.sent_at)>=:second)
      AND EXISTS (SELECT 1 FROM message_events e WHERE e.message_id=m.id AND e.type='recorded' AND e.connector_id=:connectorId)
      AND NOT EXISTS (SELECT 1 FROM message_events e WHERE e.message_id=m.id AND e.type='conflicting_copy')
    ORDER BY m.sent_at DESC, m.position DESC LIMIT :limit`, {
    chatId: job.chatId, throughPosition: job.position, sentAt: job.sentAt, connectorId: options.binding.connectorId, limit: MAX_HISTORY_TURNS, ...window,
  }).reverse();
}

function stillCurrent(tx: Tx, options: Options, job: Trigger): boolean {
  const fresh = nextTrigger(tx, options, job.chatId);
  return fresh?.messageId === job.messageId && fresh.revision === job.revision
    && fresh.evidencePosition === job.evidencePosition && fresh.brief === job.brief;
}

interface Draft {
  text: string | null;
  code: string;
  pause?: boolean;
  rule?: ReplyGuardRule;
}

async function generate(options: Options, job: Trigger, signal: AbortSignal, correction?: ReplyGuardRule): Promise<Draft> {
  const snapshot = options.db.transaction(tx => {
    if (!stillCurrent(tx, options, job)) return null;
    return historyFor(tx, options, job);
  });
  if (!snapshot || signal.aborted) return { text: null, code: 'stale' };
  const { generator } = options;
  const history = snapshot;
  const currentTurn = [history.at(-1)!.text];
  const context = job.brief ? { dispatchBrief: job.brief } : undefined;
  let text: string | null;
  if (generator.decide) {
    const decision = await generator.decide(history, signal, correction, currentTurn, undefined, context);
    if (decision.kind === 'review' || decision.paymentLinkReview) return { text: null, code: 'officer_review', pause: true };
    if (decision.kind === 'silence') return { text: null, code: decision.reason };
    text = decision.text;
  } else {
    text = await generator.generate(history, signal, correction, currentTurn, undefined, context);
  }
  text = text?.trim() ?? null;
  if (!text) return { text: null, code: 'no_reply' };
  if (text.length > MAX_REPLY_CHARS || hasInternalReplyContent(text)) return { text: null, code: 'invalid_response' };
  const rule = blockedRuleForTurn(text, history, currentTurn);
  return rule ? { text: null, code: rule, rule } : { text, code: 'reply' };
}

export function createWhatsAppReplyWorker(options: Options): JobLoop {
  const { db, binding, logger } = options;
  const shutdown = new AbortController();
  let recovery: ReturnType<typeof setTimeout> | undefined;

  function skip(job: Trigger, code: string, failed: boolean, pause = false): void {
    db.transaction(tx => {
      if (!stillCurrent(tx, options, job)) return;
      tx.run('INSERT INTO whatsapp_reply_attempts(message_id,state) VALUES (?,?)', [job.messageId, failed ? 'failed' : 'skipped']);
      record(tx, { chatId: job.chatId, workspaceId: binding.workspaceId, messageId: job.messageId, actorId: null,
        type: failed ? 'ai_reply_failed' : 'ai_reply_skipped', detail: { code, reason: code } });
      if (pause) {
        const chat = findChatById(tx, job.chatId)!;
        applyModeChange(tx, chat, { aiMode: 'paused', controllerId: null }, null, 'control_pause');
      }
    });
  }

  async function reply(job: Trigger): Promise<void> {
    let draft: Draft;
    try {
      draft = await generate(options, job, shutdown.signal);
      if (draft.rule) draft = await generate(options, job, shutdown.signal, correctionFor(draft.rule));
    } catch {
      if (!shutdown.signal.aborted) skip(job, 'generation_failed', true);
      return;
    }
    if (shutdown.signal.aborted) return;
    if (!draft.text) {
      if (draft.code !== 'stale') skip(job, draft.code, false, draft.pause);
      return;
    }
    const text = draft.text;
    // Commit before sending. A crash after this point cannot prove whether Meta accepted the reply.
    const claimed = db.transaction(tx => stillCurrent(tx, options, job) &&
      tx.run("INSERT INTO whatsapp_reply_attempts(message_id,state) VALUES (?,'sending')", [job.messageId]).changes === 1);
    if (!claimed) return;
    try {
      const id = await options.sender.sendText(job.peer, text, job.sourceId);
      db.transaction(tx => {
        if (!tx.run("UPDATE whatsapp_reply_attempts SET state='sent' WHERE message_id=? AND state='sending'", [job.messageId]).changes) return;
        const stored = ingestWhatsAppText(tx, binding, options.config, options.testerIds, {
          id, peer: job.peer, direction: 'outgoing', text, sentAt: tx.now(),
        }, job.messageId);
        record(tx, { chatId: job.chatId, workspaceId: binding.workspaceId, messageId: stored.messageId,
          actorId: null, type: 'ai_reply_sent', detail: { source: 'model', model: options.generator.model, inReplyTo: job.messageId } });
        tx.afterCommit(options.onReplyStored);
      });
    } catch {
      db.transaction(tx => {
        if (!tx.run("UPDATE whatsapp_reply_attempts SET state='uncertain' WHERE message_id=? AND state='sending'", [job.messageId]).changes) return;
        record(tx, { chatId: job.chatId, workspaceId: binding.workspaceId, messageId: job.messageId,
          actorId: null, type: 'ai_reply_failed', detail: { code: 'delivery_uncertain' } });
      });
      logger.warn('whatsapp_delivery_uncertain', { chatId: job.chatId, messageId: job.messageId });
    }
  }

  function claim(): Trigger | null {
    return db.transaction(tx => {
      const next = nextTrigger(tx, options);
      if (next) return next;
      // A crashed sender leaves an ambiguous claim. Its own trigger stays spent, but a different
      // waiting inbound can proceed after the send deadline even if no other webhook arrives.
      if (!recovery) {
        const pending = tx.get<{ seconds: number | null }>(`SELECT min(unixepoch(a.created_at)+120-unixepoch()) AS seconds
          FROM whatsapp_reply_attempts a JOIN messages m ON m.id=a.message_id JOIN chats c ON c.id=m.chat_id
          WHERE c.channel_account_id=? AND a.state='sending' AND a.created_at>datetime('now','-2 minutes')`, [binding.accountId]);
        if (pending?.seconds != null) {
          recovery = setTimeout(() => { recovery = undefined; loop.wake(); }, (pending.seconds + 1) * 1000);
          recovery.unref();
        }
      }
      return null;
    });
  }

  const loop: JobLoop = createJobLoop({
    name: 'whatsapp_demo_replies', concurrency: 1, claim,
    work: reply, onError: (_error, phase) => logger.error('whatsapp_worker_failed', { phase }),
  });
  return { ...loop, stop: async () => { shutdown.abort(); clearTimeout(recovery); await loop.stop(); } };
}


import type { Context } from 'hono';
import { TELEGRAM_SERVICE_CHAT_ID } from '../../adapters/telegram/chat-scope.ts';
import type { AppDeps } from '../../app.ts';
import { AppError, ok } from '../../contract/errors.ts';
import { IngestRequest, type IntakeEvent } from '../../contract/schemas.ts';
import type { Principal } from '../../ports/identity.ts';
import { ingest, type IntakeTarget } from '../../services/intake.ts';
import type { Tx } from '../../storage/db.ts';
import { hasTelegramLiveConnector } from '../../storage/repos/principals.ts';
import type { ChannelAccountRow } from '../../storage/rows.ts';
import { principalOf, type AppEnv, type RouteModule } from '../context.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const CREATED = 201;
const OK = 200;

/** The provisioned Business account uses its numeric owner ID. A normalized HTTP event lacks the raw private-chat
 * and bot-sender fields required for all-private filtering, so this transport can only use explicitly approved chats. */
function checkLiveHttpTarget(deps: AppDeps, tx: Tx, connector: Principal, account: ChannelAccountRow, chatId: string): void {
  if (account.source !== 'telegram') return;
  const numericOwner = /^\d+$/.test(account.external_account_id);
  if (connector.captureMethod !== 'telegram_business_live') {
    if (numericOwner && hasTelegramLiveConnector(tx, account.id)) {
      throw AppError.of('account_not_authorized', 'This Business account requires live Telegram provenance.');
    }
    return;
  }
  const { telegram } = deps.config;
  if (chatId === TELEGRAM_SERVICE_CHAT_ID || telegram.excludedChatIds.includes(chatId)) {
    throw AppError.of('account_not_authorized', 'Chat is outside the live intake scope.');
  }
  // Host-managed accounts can use symbolic external IDs, independent of the provisioned Telegram Business connection.
  if (!numericOwner) return;
  if (!deps.telegramLive.running() || telegram.chatScope !== 'approved' || !telegram.approvedChatIds.includes(chatId)) {
    throw AppError.of('account_not_authorized', 'Normalized live intake requires an enabled connection and an approved chat.');
  }
}

/** Shared by both intake routes: one transaction, then wake the workers when something new was stored. */
export function runIntake(c: Context<AppEnv>, deps: AppDeps, target: IntakeTarget, event: IntakeEvent): Response {
  const connector = principalOf(c);
  const result = deps.db.transaction((tx) => ingest(tx, connector, target, event, {
    ...deps.config,
    authorizeTarget: (account, chatId) => checkLiveHttpTarget(deps, tx, connector, account, chatId),
  }));
  const stored = result.messageEventId !== null;
  if (stored) {
    deps.workers.capture.wake();
    deps.workers.review.wake();
  }
  return c.json(ok(result), stored ? CREATED : OK);
}

export const routes: RouteModule = {
  'POST /v1/ingest': async (c, deps) => {
    const body = await parseJsonBody(c, IngestRequest);
    if (body.source === 'citizen_report') {
      throw AppError.of('validation_failed', 'Citizen reports are imported by an officer through /v1/citizen-reports.');
    }
    const target: IntakeTarget = {
      source: body.source,
      externalAccountId: body.externalAccountId,
      externalChatId: body.externalChatId,
      chat: body.chat,
    };
    return runIntake(c, deps, target, body.event);
  },
};

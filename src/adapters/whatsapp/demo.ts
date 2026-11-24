import type { AppDeps } from '../../app.ts';
import type { Config } from '../../config.ts';
import { startServer } from '../../http/server.ts';
import { createOpenRouterReplyGenerator, GEMINI_REPLY_MODEL } from '../../replies/openrouter-reply-generator.ts';
import type { ReplyGenerator } from '../../replies/reply-generator.ts';
import type { JobLoop } from '../../workers/job-loop.ts';
import { createWhatsAppReplyWorker } from '../../workers/whatsapp-reply-worker.ts';
import { createWhatsAppSender, createWhatsAppWebhook, type WhatsAppIncoming, type WhatsAppOutgoing, type WhatsAppSender } from './cloud.ts';
import { bindWhatsAppDemo, ingestWhatsAppWebhookText } from './intake.ts';
import { createYCloudSender, createYCloudWebhook } from './ycloud.ts';

export interface WhatsAppDemo {
  worker: JobLoop;
  officerId: string;
  port: number;
  close(): Promise<void>;
}

export async function startWhatsAppDemo(deps: AppDeps, settings: NonNullable<Config['whatsappDemo']>,
  overrides: { sender?: WhatsAppSender; generator?: ReplyGenerator }): Promise<WhatsAppDemo> {
  const senderId = settings.provider === 'ycloud'
    ? `ycloud:${settings.wabaId}:${settings.businessNumber.slice(1)}` : settings.phoneNumberId;
  const binding = bindWhatsAppDemo(deps.db, settings.officerId, senderId);
  const worker = createWhatsAppReplyWorker({
    db: deps.db, config: deps.config, binding, testerIds: settings.testerIds, logger: deps.logger,
    sender: overrides.sender ?? (settings.provider === 'ycloud' ? createYCloudSender(settings) : createWhatsAppSender(settings)),
    generator: overrides.generator ?? createOpenRouterReplyGenerator({
      model: GEMINI_REPLY_MODEL, apiKey: settings.geminiApiKey, timeoutMs: 60_000,
    }),
    onReplyStored: () => deps.workers.capture.wake(),
  });
  function record(message: Parameters<typeof ingestWhatsAppWebhookText>[4]): void {
    const result = deps.db.transaction(tx => ingestWhatsAppWebhookText(tx, binding, deps.config, settings.testerIds, message));
    if (result?.messageEventId) {
      deps.workers.capture.wake();
      worker.wake();
    }
  }
  const callbacks = {
    onIncoming: ({ from, ...message }: WhatsAppIncoming) => record({ ...message, peer: from, direction: 'incoming' }),
    onOutgoing: ({ to, ...message }: WhatsAppOutgoing) => record({ ...message, peer: to, direction: 'outgoing' }),
  };
  const receive = settings.provider === 'ycloud'
    ? createYCloudWebhook({ ...settings, ...callbacks })
    : createWhatsAppWebhook({ ...settings, ...callbacks });
  // A public HTTPS proxy may forward this listener. It cannot route to the officer application.
  const server = await startServer({ fetch: receive }, '127.0.0.1', settings.webhookPort);
  worker.wake();
  return { officerId: settings.officerId, port: server.port, worker, async close() {
    await Promise.all([server.close(), worker.stop()]);
  } };
}

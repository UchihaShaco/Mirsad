import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindWhatsAppDemo, ingestWhatsAppText } from '../../src/adapters/whatsapp/intake.ts';
import { loadConfig } from '../../src/config.ts';
import { provisionPrincipal, provisionWorkspace } from '../../src/identity/provision.ts';
import { dispatchChats } from '../../src/services/dispatch.ts';
import { startFreshChatTest } from '../../src/services/chat-test-session.ts';
import { applyControl } from '../../src/services/control.ts';
import { openDatabase } from '../../src/storage/db.ts';
import { createWhatsAppReplyWorker } from '../../src/workers/whatsapp-reply-worker.ts';
import type { ReplyGenerator } from '../../src/replies/reply-generator.ts';
import { FakeClock } from '../helpers/fake-clock.ts';

vi.mock('../../src/replies/ali-prompt.ts', () => ({
  ALI_PROMPT: 'Synthetic test instructions.', MINIMUM_DISTINCT_INDICATORS: 2,
  currentAliPrompt: () => ({ text: 'Synthetic test instructions.', minimumDistinctIndicators: 2, version: 'test' }),
}));

const peer = '15550100101';
function setup() {
  const clock = new FakeClock();
  const db = openDatabase(':memory:', { clock });
  const config = loadConfig({});
  const officer = db.transaction(tx => provisionPrincipal(tx, {
    workspaceId: provisionWorkspace(tx, { name: 'Demo' }).id, kind: 'officer', displayName: 'Tester',
  }).principal);
  const binding = bindWhatsAppDemo(db, officer.id, '123456');
  const testerIds = [peer, '15550100102'];
  const incoming = (id: string, text: string, from = peer, sentAt = clock.now().toISOString()) =>
    db.transaction(tx => ingestWhatsAppText(tx, binding, config, testerIds, {
      direction: 'incoming', id: 'wamid.' + id, text, sentAt, peer: from,
    }));
  const outgoing = (id: string, text: string, sentAt = clock.now().toISOString()) =>
    db.transaction(tx => ingestWhatsAppText(tx, binding, config, testerIds, {
      direction: 'outgoing', id: 'wamid.' + id, text, sentAt, peer,
    }));
  const dispatch = (id: string) => db.transaction(tx => dispatchChats(tx, officer, [id]));
  const generate = vi.fn<ReplyGenerator['generate']>().mockResolvedValue('Hello there!');
  const sendText = vi.fn<(to: string, text: string, replyTo: string) => Promise<string>>()
    .mockResolvedValue('wamid.reply001');
  const worker = () => createWhatsAppReplyWorker({
    db, config, binding, testerIds, generator: { model: 'test-gemini', generate },
    sender: { sendText }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, onReplyStored: vi.fn(),
  });
  return { db, clock, generate, sendText, worker, incoming, outgoing, dispatch, officer, testerIds };
}

describe('enrolled WhatsApp Dispatch replies', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => { env = setup(); });
  afterEach(() => { env.db.close(); });
  async function run() {
    const worker = env.worker();
    worker.wake();
    await worker.idle();
    await worker.stop();
  }

  it('answers the already-received incoming text only after Dispatch and once across replay and restart', async () => {
    env.incoming('other001', 'Separate conversation', env.testerIds[1]);
    const first = env.incoming('first001', 'Hello!');
    await run();
    expect(env.generate).not.toHaveBeenCalled();
    env.dispatch(first.chatId);
    await run();
    expect(env.generate.mock.calls[0]?.[0]).toEqual([{ from: 'contact', text: 'Hello!' }]);
    expect(env.sendText).toHaveBeenCalledExactlyOnceWith(peer, 'Hello there!', 'wamid.first001');
    env.incoming('first001', 'Hello!');
    await run();
    expect(env.sendText).toHaveBeenCalledTimes(1);
    expect(env.db.transaction(tx => tx.get('SELECT state FROM whatsapp_reply_attempts'))).toEqual({ state: 'sent' });
  });

  it('ignores expired windows and senders removed from enrollment', async () => {
    const old = env.incoming('old001', 'Old', peer, new Date(+env.clock.now() - 86_400_000).toISOString());
    env.dispatch(old.chatId);
    await run();
    env.incoming('new001', 'New');
    env.testerIds.splice(0, 1);
    await run();
    expect(env.generate).not.toHaveBeenCalled();
  });

  it('discards a draft if the officer takes control during generation', async () => {
    const first = env.incoming('incoming001', 'Hello');
    env.dispatch(first.chatId);
    env.generate.mockImplementationOnce(async () => {
      env.db.transaction(tx => applyControl(tx, env.officer, first.chatId, 'take_over', 2));
      return 'Hello!';
    });
    await run();
    expect(env.sendText).not.toHaveBeenCalled();
  });

  it('uses the newer inbound if a second message arrives during generation', async () => {
    const first = env.incoming('incoming001', 'Hello');
    env.dispatch(first.chatId);
    env.generate.mockImplementationOnce(async () => {
      env.clock.advance(1000);
      env.incoming('incoming002', 'Are you there?');
      return 'Discard this draft.';
    });
    await run();
    expect(env.sendText).toHaveBeenCalledExactlyOnceWith(peer, 'Hello there!', 'wamid.incoming002');
  });

  it('leaves an ambiguous transport failure spent on restart', async () => {
    const first = env.incoming('incoming001', 'Hello');
    env.dispatch(first.chatId);
    env.sendText.mockRejectedValueOnce(new Error('synthetic timeout'));
    await run();
    await run();
    expect(env.sendText).toHaveBeenCalledTimes(1);
    expect(env.db.transaction(tx => tx.get('SELECT state FROM whatsapp_reply_attempts'))).toEqual({ state: 'uncertain' });
  });

  it('honors a manual WhatsApp Web reply even when the incoming webhook from the same second arrives last', async () => {
    env.outgoing('manual001', 'Already answered.');
    const first = env.incoming('incoming001', 'Hello');
    env.dispatch(first.chatId);
    await run();
    expect(env.generate).not.toHaveBeenCalled();
    env.clock.advance(1000);
    env.incoming('incoming002', 'Another question.');
    await run();
    expect(env.sendText).toHaveBeenCalledExactlyOnceWith(peer, 'Hello there!', 'wamid.incoming002');
  });

  it('uses only the current test episode even when an older webhook is delivered after the reset', async () => {
    const oldSentAt = env.clock.now().toISOString();
    const first = env.incoming('incoming001', 'Old scenario.');
    env.dispatch(first.chatId);
    env.clock.advance(5000);
    env.db.transaction(tx => startFreshChatTest(tx, first.chatId, env.officer.id));
    env.incoming('incoming002', 'Late old scenario.', peer, oldSentAt);
    await run();
    expect(env.generate).not.toHaveBeenCalled();
    env.clock.advance(1000);
    env.incoming('incoming003', 'New scenario.');
    await run();
    expect(env.generate.mock.calls[0]?.[0]).toEqual([{ from: 'contact', text: 'New scenario.' }]);
  });

  it('respects withdrawal between generation and send, even after a later Dispatch', async () => {
    const first = env.incoming('incoming001', 'Hello');
    env.dispatch(first.chatId);
    env.generate.mockImplementationOnce(async () => {
      env.incoming('incoming002', 'STOP');
      return 'Draft in flight.';
    });
    await run();
    env.dispatch(first.chatId);
    await run();
    expect(env.generate).toHaveBeenCalledTimes(1);
    expect(env.sendText).not.toHaveBeenCalled();
  });

  it('keeps the receipt for a send already in flight when the tester withdraws', async () => {
    const first = env.incoming('incoming001', 'Hello');
    env.dispatch(first.chatId);
    env.sendText.mockImplementationOnce(async () => {
      env.incoming('incoming002', 'STOP');
      return 'wamid.reply001';
    });
    await run();
    expect(env.sendText).toHaveBeenCalledTimes(1);
    expect(env.db.transaction(tx => tx.get('SELECT state FROM whatsapp_reply_attempts'))).toEqual({ state: 'sent' });
    await run();
    expect(env.generate).toHaveBeenCalledTimes(1);
  });

  it('can accept the same concurrent Dispatch wake in two workers without delivering twice', async () => {
    const first = env.incoming('incoming001', 'Hello');
    env.dispatch(first.chatId);
    let release!: () => void;
    const both = new Promise<void>(resolve => { release = resolve; });
    env.generate.mockImplementation(async () => {
      if (env.generate.mock.calls.length === 2) release();
      await both;
      return 'Hello there!';
    });
    const workerA = env.worker();
    const workerB = env.worker();
    workerA.wake();
    workerB.wake();
    await Promise.all([workerA.idle(), workerB.idle()]);
    await Promise.all([workerA.stop(), workerB.stop()]);
    expect(env.sendText).toHaveBeenCalledTimes(1);
  });
});


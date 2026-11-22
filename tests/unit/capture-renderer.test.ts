import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawCaptureCard } from '../../src/capture/card.ts';
import { createDefaultRenderer } from '../../src/capture/index.ts';
import { BODY_FONT, CONTENT_WIDTH, MAX_CARD_HEIGHT } from '../../src/capture/layout.ts';
import { readTextChunks } from '../../src/capture/png-metadata.ts';
import { toDisplayText } from '../../src/domain/text-safety.ts';
import type { CaptureRenderInput } from '../../src/ports/capture-renderer.ts';

// Code points are built at run time so this file stays ASCII.
const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_HEIGHT_OFFSET = 20;
const ARABIC = cp(0x0645, 0x0631, 0x062d, 0x0628, 0x0627, 0x20, 0x0628, 0x0643, 0x0645);
const MIXED = `${ARABIC} https://pay.example.test/path?q=1 Mirsad +44 7700 900123 ${cp(0x0661, 0x0662, 0x0663)}`;

function captureInput(overrides: Partial<CaptureRenderInput> = {}): CaptureRenderInput {
  const text = overrides.text ?? 'Hello, the parcel arrives tomorrow at 09:30.\nSecond line.';
  return {
    captureKind: 'mirsad_rendered_capture',
    channel: 'telegram',
    captureMethod: 'fixture_replay',
    chatLabel: 'Test Contact',
    chatId: 'chat_00000000000000000000000000000001',
    messageId: 'msg_00000000000000000000000000000002',
    messageEventId: 'mev_00000000000000000000000000000003',
    eventType: 'recorded',
    direction: 'incoming',
    senderLabel: 'Test Contact (9001)',
    receivedAt: '2026-11-21T08:00:00.000Z',
    sentAt: '2026-11-21T07:59:00.000Z',
    unsupportedContent: [],
    ...overrides,
    text,
    textSha256: overrides.textSha256 ?? sha256(text),
  };
}

interface DrawCall {
  text: string;
  x: number;
  direction: string;
  textAlign: string;
}

interface TextContext {
  direction: string;
  textAlign: string;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
}

/** Records every string the renderer draws, with the direction and alignment in force at that moment. */
function watchDrawnText(): DrawCall[] {
  const proto = Object.getPrototypeOf(createCanvas(1, 1).getContext('2d')) as TextContext;
  const original = proto.fillText;
  const calls: DrawCall[] = [];
  vi.spyOn(proto, 'fillText').mockImplementation(function (this: TextContext, text: string, x: number, y: number, maxWidth?: number) {
    calls.push({ text: String(text), x, direction: this.direction, textAlign: this.textAlign });
    return maxWidth === undefined ? original.call(this, text, x, y) : original.call(this, text, x, y, maxWidth);
  });
  return calls;
}

const RENDERER_TOKEN = new RegExp(`${cp(0x2068)}\\[U\\+[0-9A-F]{4,6}\\]${cp(0x2069)}`, 'g');
const HIDDEN_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];

/** Code points that would be invisible or reorder text, once the renderer's own isolated tokens are removed. */
function hiddenCodePoints(drawn: string): number[] {
  return [...drawn.replace(RENDERER_TOKEN, '')]
    .map((char) => char.codePointAt(0) ?? 0)
    .filter((code) => HIDDEN_RANGES.some(([low = 0, high = 0]) => code >= low && code <= high));
}

const renderer = createDefaultRenderer();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('capture renderer', () => {
  it('the renderer returns a PNG with the provenance text chunks', async () => {
    const input = captureInput();
    const png = await renderer.render(input);
    expect([...png.subarray(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE);
    expect(readTextChunks(png)).toEqual({
      'Mirsad-Capture-Kind': 'mirsad_rendered_capture',
      'Mirsad-Chat-Id': input.chatId,
      'Mirsad-Message-Id': input.messageId,
      'Mirsad-Message-Event-Id': input.messageEventId,
      'Mirsad-Received-At': input.receivedAt,
      'Mirsad-Text-SHA256': input.textSha256,
    });
  });

  it('the same input renders byte-identical output', async () => {
    const first = await renderer.render(captureInput({ text: MIXED }));
    const second = await renderer.render(captureInput({ text: MIXED }));
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    const other = await renderer.render(captureInput({ text: `${MIXED}!` }));
    expect(Buffer.from(other).equals(Buffer.from(first))).toBe(false);
  });

  it('a 20,000-character message renders completely', async () => {
    const words = Array.from({ length: 2000 }, (_, i) => `word${String(i).padStart(5, '0')}`);
    const text = `${words.map((word, i) => (i === 0 ? word : `${i % 100 === 0 ? '\n' : ' '}${word}`)).join('')}.`;
    expect(text.length).toBe(20_000);
    const calls = watchDrawnText();
    await renderer.render(captureInput({ text }));

    const bodyLines = calls.map((call) => call.text).filter((drawn) => /^word\d{5}/.test(drawn));
    const joined = bodyLines.join(' ');
    let from = 0;
    for (const word of words) {
      const at = joined.indexOf(word, from);
      expect(at, word).toBeGreaterThanOrEqual(0);
      from = at + word.length;
    }
    expect(calls.some((call) => call.text.includes('TRUNCATED'))).toBe(false);
    const measure = createCanvas(10, 10).getContext('2d');
    measure.font = BODY_FONT;
    for (const line of bodyLines) expect(measure.measureText(line).width, line).toBeLessThanOrEqual(CONTENT_WIDTH);
  });

  it('every drawn string, including the chat label and the sender name, goes through toDisplayText', async () => {
    const input = captureInput({
      chatLabel: `Test ${cp(0x202e)}tcatnoC${cp(0x202c)}\n<b>Second line</b>`,
      senderLabel: `Demo ${cp(0x2067)}Sender${cp(0x2069)} (9001${cp(0x200b)})`,
      chatId: `chat_${cp(0x2066)}1`,
      messageId: `msg_${cp(0x0007)}2`,
      text: `Body <script>alert(1)</script> invoice${cp(0x202e)}gnp.exe${cp(0)}`,
      unsupportedContent: [`photo${cp(0x200d)}`],
    });
    const calls = watchDrawnText();
    // The drawing step itself: real IDs are server-generated ASCII, and the PNG chunk writer refuses anything else.
    await drawCaptureCard(input);
    const drawn = calls.map((call) => call.text);

    expect(drawn).toContain('Mirsad-rendered capture');
    for (const value of [input.chatLabel, input.senderLabel ?? '', input.chatId, input.messageId, `photo${cp(0x200d)}`]) {
      expect(drawn).toContain(toDisplayText(value, { singleLine: true }));
    }
    expect(drawn).toContain(toDisplayText(input.text));
    for (const text of drawn) expect(hiddenCodePoints(text), JSON.stringify(text)).toEqual([]);
  });

  it("an edit's capture labels the source time as the edit time; a recording and a conflicting copy label it as the sent time", async () => {
    const at = '2026-11-21T08:05:00.000Z';
    for (const [eventType, label, other] of [
      ['edited', 'Edited (UTC):', 'Sent (UTC):'],
      ['recorded', 'Sent (UTC):', 'Edited (UTC):'],
      ['conflicting_copy', 'Sent (UTC):', 'Edited (UTC):'],
    ] as const) {
      const calls = watchDrawnText();
      await drawCaptureCard(captureInput({ eventType, sentAt: at }));
      const drawn = calls.map((call) => call.text);
      expect(drawn.slice(drawn.indexOf(label), drawn.indexOf(label) + 2), eventType).toEqual([label, at]);
      expect(drawn, eventType).not.toContain(other);
      vi.restoreAllMocks();
    }
  });

  it('paragraphs take their base direction from the first strong character', async () => {
    const calls = watchDrawnText();
    await renderer.render(captureInput({ text: `${ARABIC} Mirsad 2026\nEnglish first ${ARABIC}\n12345` }));
    const line = (prefix: string) => calls.find((call) => call.text.startsWith(prefix));
    expect(line(ARABIC)).toMatchObject({ direction: 'rtl', textAlign: 'right' });
    expect(line('English first')).toMatchObject({ direction: 'ltr', textAlign: 'left' });
    expect(line('12345')).toMatchObject({ direction: 'ltr', textAlign: 'left' });
    expect(line(ARABIC)?.x).toBeGreaterThan(line('English first')?.x ?? Number.POSITIVE_INFINITY);
  });

  it('a message taller than the card cap ends with a visible truncation notice and keeps the full-text hash', async () => {
    const text = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n');
    const calls = watchDrawnText();
    const png = await renderer.render(captureInput({ text }));
    const drawn = calls.map((call) => call.text);

    expect(drawn.find((d) => d.startsWith('[TRUNCATED'))).toMatch(/^\[TRUNCATED: \d+ of 1200 lines shown; SHA-256 below covers the full text\]$/);
    expect(drawn).toContain('line 0');
    expect(drawn).not.toContain('line 1199');
    expect(drawn).toContain(sha256(text));
    expect(Buffer.from(png).readUInt32BE(PNG_HEIGHT_OFFSET)).toBeLessThanOrEqual(MAX_CARD_HEIGHT);
  });

  it('the renderer source is ASCII-only', () => {
    const captureDir = fileURLToPath(new URL('../../src/capture/', import.meta.url));
    const files = [
      ...fs.readdirSync(captureDir, { recursive: true, encoding: 'utf8' }).map((name) => path.join(captureDir, name)),
      fileURLToPath(new URL('../../src/domain/text-safety.ts', import.meta.url)),
    ].filter((file) => fs.statSync(file).isFile());
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const bytes = fs.readFileSync(file);
      const offsets = [...bytes.entries()].filter(([, byte]) => byte > 0x7f).map(([offset]) => offset);
      expect(offsets, path.basename(file)).toEqual([]);
    }
  });
});

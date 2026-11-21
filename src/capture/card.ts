/**
 * Draws one capture card (design section 9): the "Mirsad-rendered capture" label, the record's metadata, the text
 * and the text's SHA-256. Every value taken from the record passes through toDisplayText before it is drawn, and
 * fillText draws plain text, so markup is never interpreted.
 */
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { CHANNEL_LABELS, LABELS } from '../contract/labels.ts';
import { toDisplayText } from '../domain/text-safety.ts';
import type { CaptureRenderInput } from '../ports/capture-renderer.ts';
import { FONT } from './fonts.ts';
import {
  BODY_FONT,
  BODY_LINE_HEIGHT,
  CARD_WIDTH,
  CONTENT_WIDTH,
  MAX_CARD_HEIGHT,
  PADDING,
  layoutBody,
  type BodyLine,
} from './layout.ts';

const HEADER_HEIGHT = 48;
const HEADER_BASELINE = 32;
const HEADER_FONT = `20px ${FONT.sansBold}`;
const ROW_FONT = `15px ${FONT.sans}, ${FONT.arabic}`;
const ROW_LABEL_FONT = `15px ${FONT.sansBold}, ${FONT.arabicBold}`;
const HASH_FONT = `13px ${FONT.mono}, ${FONT.sans}`;
const ROW_HEIGHT = 22;
const ROW_VALUE_OFFSET = 190;
const SECTION_GAP = 16;
const RULE_OFFSET = 4;
const RULE_THICKNESS = 1;
/** The first body line sits slightly higher than a full line height below the rule. */
const FIRST_LINE_RAISE = 6;
const FIRST_BODY_BASELINE = SECTION_GAP + BODY_LINE_HEIGHT - FIRST_LINE_RAISE;
const FOOTER_HEIGHT = 64;
const FOOTER_LABEL_BASELINE = 24;
const FOOTER_HASH_BASELINE = 46;
const MEASURE_CANVAS_HEIGHT = 10;
const NOT_GIVEN = 'not given';
const FOOTER_LABEL = 'SHA-256 of the message text (UTF-8):';

const COLORS = {
  background: '#ffffff',
  ink: '#111827',
  muted: '#4b5563',
  rule: '#d1d5db',
  band: '#0f172a',
  bandInk: '#f8fafc',
} as const;

interface CardRow {
  label: string;
  value: string;
}

interface CardLayout {
  rows: CardRow[];
  body: BodyLine[];
  height: number;
}

/** The record's values as drawn: each passes through toDisplayText and stays on one line. */
function cardRows(input: CaptureRenderInput): CardRow[] {
  const rows: (readonly [string, string])[] = [
    ['Channel', CHANNEL_LABELS[input.channel]],
    ['Capture method', input.captureMethod],
    ['Chat label', input.chatLabel],
    ['Chat ID', input.chatId],
    ['Message ID', input.messageId],
    ['Event ID', input.messageEventId],
    ['Event type', input.eventType],
    ['Direction', input.direction ?? NOT_GIVEN],
    ['Sender', input.senderLabel ?? NOT_GIVEN],
    ['Received (UTC)', input.receivedAt],
    ['Sent (UTC)', input.sentAt ?? NOT_GIVEN],
    ['Unsupported content', input.unsupportedContent.length > 0 ? input.unsupportedContent.join(', ') : 'none'],
  ];
  return rows.map(([label, value]) => ({ label, value: toDisplayText(value, { singleLine: true }) }));
}

function layoutCard(input: CaptureRenderInput): CardLayout {
  const rows = cardRows(input);
  const fixedHeight = HEADER_HEIGHT + PADDING + rows.length * ROW_HEIGHT + SECTION_GAP * 2 + PADDING + FOOTER_HEIGHT;
  // One line below the cap stays free for the truncation notice.
  const maxBodyLines = Math.floor((MAX_CARD_HEIGHT - fixedHeight) / BODY_LINE_HEIGHT) - 1;
  const measure = createCanvas(CARD_WIDTH, MEASURE_CANVAS_HEIGHT).getContext('2d');
  const body = layoutBody(measure, toDisplayText(input.text), maxBodyLines);
  return { rows, body, height: fixedHeight + Math.max(1, body.length) * BODY_LINE_HEIGHT };
}

function leftToRight(ctx: SKRSContext2D): void {
  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
}

function drawHeader(ctx: SKRSContext2D): void {
  ctx.fillStyle = COLORS.band;
  ctx.fillRect(0, 0, CARD_WIDTH, HEADER_HEIGHT);
  ctx.fillStyle = COLORS.bandInk;
  ctx.font = HEADER_FONT;
  leftToRight(ctx);
  ctx.fillText(LABELS.mirsadRenderedCapture, PADDING, HEADER_BASELINE);
}

/** Draws the metadata rows and returns the y position after the last one. */
function drawRows(ctx: SKRSContext2D, rows: readonly CardRow[]): number {
  let y = HEADER_HEIGHT + PADDING;
  for (const row of rows) {
    leftToRight(ctx);
    ctx.fillStyle = COLORS.muted;
    ctx.font = ROW_LABEL_FONT;
    ctx.fillText(`${row.label}:`, PADDING, y);
    ctx.fillStyle = COLORS.ink;
    ctx.font = ROW_FONT;
    // maxWidth squeezes an over-long value horizontally; it never clips it.
    ctx.fillText(row.value, PADDING + ROW_VALUE_OFFSET, y, CONTENT_WIDTH - ROW_VALUE_OFFSET);
    y += ROW_HEIGHT;
  }
  return y;
}

function drawBody(ctx: SKRSContext2D, body: readonly BodyLine[], rowsEnd: number): void {
  const ruleY = rowsEnd + RULE_OFFSET;
  ctx.fillStyle = COLORS.rule;
  ctx.fillRect(PADDING, ruleY, CONTENT_WIDTH, RULE_THICKNESS);
  ctx.fillStyle = COLORS.ink;
  ctx.font = BODY_FONT;
  let y = ruleY + FIRST_BODY_BASELINE;
  for (const line of body) {
    const rightToLeft = line.direction === 'rtl';
    ctx.direction = line.direction;
    ctx.textAlign = rightToLeft ? 'right' : 'left';
    // One fillText per visual line, so canvas applies the bidi algorithm to the whole line.
    ctx.fillText(line.text, rightToLeft ? CARD_WIDTH - PADDING : PADDING, y);
    y += BODY_LINE_HEIGHT;
  }
}

function drawFooter(ctx: SKRSContext2D, displayHash: string, height: number): void {
  const top = height - FOOTER_HEIGHT;
  ctx.fillStyle = COLORS.rule;
  ctx.fillRect(PADDING, top, CONTENT_WIDTH, RULE_THICKNESS);
  leftToRight(ctx);
  ctx.fillStyle = COLORS.muted;
  ctx.font = ROW_LABEL_FONT;
  ctx.fillText(FOOTER_LABEL, PADDING, top + FOOTER_LABEL_BASELINE);
  ctx.fillStyle = COLORS.ink;
  ctx.font = HASH_FONT;
  ctx.fillText(displayHash, PADDING, top + FOOTER_HASH_BASELINE);
}

/** Draws the card and encodes it as PNG. The same input gives the same bytes on one platform and library build. */
export async function drawCaptureCard(input: CaptureRenderInput): Promise<Uint8Array> {
  const card = layoutCard(input);
  const canvas = createCanvas(CARD_WIDTH, card.height);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, CARD_WIDTH, card.height);
  drawHeader(ctx);
  drawBody(ctx, card.body, drawRows(ctx, card.rows));
  drawFooter(ctx, toDisplayText(input.textSha256, { singleLine: true }), card.height);
  const png = await canvas.encode('png');
  return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
}

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { addTextChunks, readTextChunks } from '../../src/capture/png-metadata.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IEND_CHUNK_BYTES = 12;

async function smallPng(): Promise<Uint8Array> {
  const canvas = createCanvas(3, 2);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, 3, 2);
  return new Uint8Array(await canvas.encode('png'));
}

const ENTRIES = {
  'Mirsad-Capture-Kind': 'mirsad_rendered_capture',
  'Mirsad-Message-Id': 'msg_0123456789abcdef0123456789abcdef',
  'Mirsad-Received-At': '2026-11-21T08:00:00.000Z',
};

describe('PNG text chunks', () => {
  it('addTextChunks and readTextChunks round-trip', async () => {
    const png = await smallPng();
    const original = Uint8Array.from(png);
    expect(readTextChunks(png)).toEqual({});

    const tagged = addTextChunks(png, ENTRIES);
    expect(readTextChunks(tagged)).toEqual(ENTRIES);
    expect(png).toEqual(original);
    expect([...tagged.subarray(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE);
    expect([...tagged.subarray(-IEND_CHUNK_BYTES)]).toEqual([...png.subarray(-IEND_CHUNK_BYTES)]);

    const decoded = await loadImage(Buffer.from(tagged));
    expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 3, height: 2 });
  });

  it('addTextChunks refuses input that is not a PNG and keywords or values that are not printable ASCII', async () => {
    const png = await smallPng();
    expect(() => addTextChunks(Uint8Array.of(1, 2, 3), ENTRIES)).toThrow('invalid_png');
    expect(() => addTextChunks(png.subarray(0, png.length - IEND_CHUNK_BYTES), ENTRIES)).toThrow('invalid_png');
    for (const keyword of ['', 'k'.repeat(80), ' Leading', 'Trailing ', 'Double  Space', `Non${String.fromCodePoint(0xe9)}ascii`]) {
      expect(() => addTextChunks(png, { [keyword]: 'value' }), JSON.stringify(keyword)).toThrow('invalid_png_text_chunk');
    }
    for (const value of ['line\nbreak', `nul${String.fromCharCode(0)}`, `caf${String.fromCodePoint(0xe9)}`]) {
      expect(() => addTextChunks(png, { 'Mirsad-Chat-Id': value }), JSON.stringify(value)).toThrow('invalid_png_text_chunk');
    }
  });

  it('readTextChunks refuses a damaged text chunk or a truncated file', async () => {
    const tagged = addTextChunks(await smallPng(), ENTRIES);
    const damaged = Uint8Array.from(tagged);
    const at = Buffer.from(damaged).indexOf('msg_0123');
    damaged[at] = 'n'.charCodeAt(0);
    expect(() => readTextChunks(damaged)).toThrow('png_chunk_crc_mismatch');
    expect(() => readTextChunks(tagged.subarray(0, tagged.length - 4))).toThrow('invalid_png');
  });
});

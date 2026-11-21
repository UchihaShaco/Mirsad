/**
 * PNG tEXt chunks (PNG specification, section 11.3.4.3). Provenance is written into a rendered capture after the
 * image is encoded; the image chunks themselves are copied unchanged. Keywords and values are printable ASCII.
 */
import { crc32 } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const LENGTH_BYTES = 4;
const TYPE_BYTES = 4;
const CRC_BYTES = 4;
const CHUNK_OVERHEAD = LENGTH_BYTES + TYPE_BYTES + CRC_BYTES;
const MAX_CHUNK_LENGTH = 0x7fffffff;
const MAX_KEYWORD_LENGTH = 79;
const TEXT_TYPE = 'tEXt';
const END_TYPE = 'IEND';
const KEYWORD_SEPARATOR = 0x00;
const FIRST_PRINTABLE = 0x20;
const LAST_PRINTABLE = 0x7e;

interface ChunkRef {
  type: string;
  /** Offset of the chunk's length field. */
  offset: number;
  dataOffset: number;
  length: number;
}

const hasSignature = (png: Uint8Array): boolean => SIGNATURE.every((byte, index) => png[index] === byte);

/** Every chunk up to and including IEND, with bounds checked; throws `invalid_png` on anything malformed. */
function readChunks(png: Uint8Array): ChunkRef[] {
  if (!hasSignature(png)) throw new Error('invalid_png');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: ChunkRef[] = [];
  let offset = SIGNATURE.length;
  while (offset + CHUNK_OVERHEAD <= png.byteLength) {
    const length = view.getUint32(offset);
    const dataOffset = offset + LENGTH_BYTES + TYPE_BYTES;
    if (length > MAX_CHUNK_LENGTH || dataOffset + length + CRC_BYTES > png.byteLength) throw new Error('invalid_png');
    const type = Buffer.from(png.subarray(offset + LENGTH_BYTES, dataOffset)).toString('latin1');
    chunks.push({ type, offset, dataOffset, length });
    if (type === END_TYPE) return chunks;
    offset = dataOffset + length + CRC_BYTES;
  }
  throw new Error('invalid_png');
}

const isPrintableAscii = (value: string): boolean =>
  [...value].every((char) => char.charCodeAt(0) >= FIRST_PRINTABLE && char.charCodeAt(0) <= LAST_PRINTABLE);

/** 1 to 79 printable characters with no leading, trailing or repeated spaces. */
const isValidKeyword = (keyword: string): boolean =>
  keyword.length > 0 &&
  keyword.length <= MAX_KEYWORD_LENGTH &&
  isPrintableAscii(keyword) &&
  keyword.trim() === keyword &&
  !keyword.includes('  ');

function textChunk(keyword: string, value: string): Buffer {
  if (!isValidKeyword(keyword) || !isPrintableAscii(value)) throw new Error('invalid_png_text_chunk');
  const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.of(KEYWORD_SEPARATOR), Buffer.from(value, 'latin1')]);
  const typeAndData = Buffer.concat([Buffer.from(TEXT_TYPE, 'latin1'), data]);
  const chunk = Buffer.alloc(CHUNK_OVERHEAD + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeAndData.copy(chunk, LENGTH_BYTES);
  chunk.writeUInt32BE(crc32(typeAndData), LENGTH_BYTES + typeAndData.length);
  return chunk;
}

/** Returns a new PNG with one tEXt chunk per entry, inserted before IEND. The input is not modified. */
export function addTextChunks(png: Uint8Array, entries: Readonly<Record<string, string>>): Uint8Array {
  const end = readChunks(png).at(-1);
  if (!end) throw new Error('invalid_png');
  const chunks = Object.entries(entries).map(([keyword, value]) => textChunk(keyword, value));
  return new Uint8Array(Buffer.concat([png.subarray(0, end.offset), ...chunks, png.subarray(end.offset)]));
}

function decodeTextChunk(png: Uint8Array, chunk: ChunkRef): [string, string] {
  const dataEnd = chunk.dataOffset + chunk.length;
  const stored = new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(dataEnd);
  if (crc32(png.subarray(chunk.offset + LENGTH_BYTES, dataEnd)) !== stored) throw new Error('png_chunk_crc_mismatch');
  const data = Buffer.from(png.subarray(chunk.dataOffset, dataEnd));
  const separator = data.indexOf(KEYWORD_SEPARATOR);
  if (separator < 1) throw new Error('invalid_png_text_chunk');
  return [data.subarray(0, separator).toString('latin1'), data.subarray(separator + 1).toString('latin1')];
}

/** All tEXt entries of a PNG (a repeated keyword keeps its last value); each chunk's CRC is checked. */
export function readTextChunks(png: Uint8Array): Record<string, string> {
  const textChunks = readChunks(png).filter((chunk) => chunk.type === TEXT_TYPE);
  return Object.fromEntries(textChunks.map((chunk) => decodeTextChunk(png, chunk)));
}

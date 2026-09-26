// Image files made by hand for the upload checks (DESIGN §21): headers that claim more than their bytes hold, and
// an SVG behind another format's magic bytes. Nothing here needs sharp, so any test (or child script) can use them.
import { crc32, deflateSync } from 'node:zlib';

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export interface PngHeader {
  /** 8 or 16. */
  bitDepth?: number;
  /** 0 grey, 2 RGB, 4 grey + alpha, 6 RGBA. */
  colorType?: number;
  /** Adam7 interlacing (sharp reports it as isProgressive). */
  interlaced?: boolean;
}

/**
 * A PNG whose header says `width` x `height` but whose pixel data is a few bytes: its metadata reads fine (a
 * decompression bomb as far as the header goes), decoding it fails. Tiny, and made without sharp.
 */
export function pngHeaderOnly(width: number, height: number, { bitDepth = 8, colorType = 6, interlaced = false }: PngHeader = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = interlaced ? 1 : 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(64))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * An SVG whose first bytes read as an AVIF (bytes 4..12 are "ftypavif"): the upload's magic-byte check calls it
 * HEIF. It draws a green 400 x 200 picture and pulls in `href` (e.g. another attachment next to it) when rendered.
 */
export function svgBehindAvifHeader(href = 'sibling.png'): Buffer {
  return Buffer.from(
    '<!--ftypavif--><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200">' +
      `<rect width="400" height="200" fill="#0a0"/><image width="200" height="100" xlink:href="${href}"/></svg>`,
  );
}

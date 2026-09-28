#!/usr/bin/env node
// Stand-in for ffmpeg in the recording tests (DESIGN §22): accepts the server's single-pass command line
// (-i <source> … -f wav <asr> … -f ipod <playback>), expects a 16 kHz mono PCM WAV as the source (the tests upload
// generated ones) and copies its samples into the ASR WAV; the "playback" file is a small stub.
//
// Environment:
//   FAKE_FFMPEG_EXIT=183|234   fail like the real one ("moov atom not found" / "matches no streams")
//   FAKE_FFMPEG_MAX_BYTES=<n>  copy at most n PCM bytes (large-upload tests)
//   FAKE_FFMPEG_LOG=<file>     append the argument list as one JSON line
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('-version')) {
  process.stdout.write('ffmpeg version 8.1-fake Copyright (c) 2000-2026 the FFmpeg developers\n');
  process.exit(0);
}
if (process.env.FAKE_FFMPEG_LOG) fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, `${JSON.stringify(args)}\n`);
const input = args[args.indexOf('-i') + 1];
const outputs = {};
for (let i = 0; i < args.length - 1; i++) if (args[i] === '-f') outputs[args[i + 1]] = args[i + 2];

const exit = Number(process.env.FAKE_FFMPEG_EXIT ?? 0);
if (exit === 183) {
  process.stderr.write(`[mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] moov atom not found\n${input}: Invalid data found when processing input\n`);
  process.exit(183);
}
if (exit === 234) {
  process.stderr.write("Stream map '0:a:0' matches no streams.\n");
  process.exit(234);
}

const fd = fs.openSync(input, 'r');
const head = Buffer.alloc(64);
fs.readSync(fd, head, 0, 64, 0);
if (head.toString('ascii', 0, 4) !== 'RIFF') {
  process.stderr.write(`${input}: Invalid data found when processing input\n`);
  process.exit(183);
}
const size = fs.fstatSync(fd).size;
const dataOffset = 44;
const max = Number(process.env.FAKE_FFMPEG_MAX_BYTES ?? Infinity);
const length = Math.min(size - dataOffset, max) - (Math.min(size - dataOffset, max) % 2);
process.stderr.write(`Input #0, wav, from '${input}':\n  Duration: 00:00:${(length / 32000).toFixed(2).padStart(5, '0')}, bitrate: 256 kb/s\n`);

const header = Buffer.alloc(44);
header.write('RIFF', 0, 'ascii');
header.writeUInt32LE(36 + length, 4);
header.write('WAVE', 8, 'ascii');
header.write('fmt ', 12, 'ascii');
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24);
header.writeUInt32LE(32000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36, 'ascii');
header.writeUInt32LE(length, 40);
const out = fs.openSync(outputs.wav, 'w');
fs.writeSync(out, header, 0, 44, 0);
const piece = Buffer.alloc(1 << 20);
for (let done = 0; done < length; ) {
  const n = fs.readSync(fd, piece, 0, Math.min(piece.length, length - done), dataOffset + done);
  if (n <= 0) break;
  fs.writeSync(out, piece, 0, n, 44 + done);
  done += n;
}
fs.closeSync(out);
fs.closeSync(fd);
fs.writeFileSync(outputs.ipod, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A \0\0\0\0isomM4A '), Buffer.alloc(1000)]));

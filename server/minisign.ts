// Minisign signatures the way the Tauri updater makes and checks them (DESIGN §24, §26): a TypeScript port of
// desktop/scripts/minisign.mjs for `easy-study update` (server/selfUpdate.ts), which checks the Linux server tarball
// with the same public key the desktop app's updater trusts. node:crypto and node:fs only.
//
// Formats (https://jedisct1.github.io/minisign/). Tauri wraps both texts in one more layer of base64: the
// `pubkey` in tauri.conf.json, the .key.pub file and the .sig file are base64 of the minisign text.
//   public key:  "untrusted comment: minisign public key: <KEY ID>\n" + base64("Ed" ‖ key id (8, LE) ‖ Ed25519 key (32))
//   signature:   "untrusted comment: …\n" + base64("ED" ‖ key id ‖ Ed25519(BLAKE2b-512(file)) (64)) + "\n"
//                "trusted comment: timestamp:<s>\tfile:<name>\tversion:<v>\n" + base64(Ed25519(sig ‖ trusted comment))
// "ED" is the prehashed form `tauri signer sign` always writes; the legacy "Ed" (the file itself signed) is refused.
// The trusted comment is covered by the global signature: its `file:` and `version:` name the signed asset.
import crypto from 'node:crypto';
import fs from 'node:fs';

/** A parsed minisign public key. */
export interface MinisignPublicKey {
  /** The key id as minisign prints it (16 upper-case hex digits). */
  keyId: string;
  /** The raw Ed25519 public key (32 bytes). */
  key: Buffer;
}

/** A parsed minisign signature. */
export interface MinisignSignature {
  keyId: string;
  /** Ed25519 over BLAKE2b-512 of the file (64 bytes). */
  signature: Buffer;
  trustedComment: string;
  /** Ed25519 over signature ‖ trusted comment (64 bytes). */
  globalSignature: Buffer;
}

/** The minisign text of `text`: as is when it already is one, else Tauri's base64 wrapping decoded. */
export function minisignText(text: string): string {
  const t = String(text).trim();
  if (t.startsWith('untrusted comment:')) return t;
  if (!/^[A-Za-z0-9+/]+=*$/.test(t)) throw new Error('neither minisign text nor base64');
  const decoded = Buffer.from(t, 'base64').toString('utf8');
  if (!decoded.startsWith('untrusted comment:')) throw new Error('base64 of something other than minisign text');
  return decoded.trim();
}

/** A key id as minisign prints it: the 8 little-endian bytes as one hex number. */
function keyIdHex(bytes: Buffer): string {
  return Buffer.from(bytes).reverse().toString('hex').toUpperCase();
}

function base64Line(line: string | undefined, length: number, what: string): Buffer {
  if (!/^[A-Za-z0-9+/]+=*$/.test(line ?? '')) throw new Error(`${what}: not base64`);
  const buf = Buffer.from(line as string, 'base64');
  if (buf.length !== length) throw new Error(`${what}: ${buf.length} bytes, expected ${length}`);
  return buf;
}

/** { keyId, key } of a minisign public key (the `pubkey` of tauri.conf.json or a .key.pub file). */
export function parsePublicKey(text: string): MinisignPublicKey {
  const lines = minisignText(text).split('\n');
  const buf = base64Line(lines[1]?.trim(), 42, 'public key');
  if (buf.toString('latin1', 0, 2) !== 'Ed') throw new Error('public key: not an Ed25519 minisign key');
  return { keyId: keyIdHex(buf.subarray(2, 10)), key: buf.subarray(10) };
}

/** The parts of a minisign signature (a .sig file, or latest.json's `signature`). */
export function parseSignature(text: string): MinisignSignature {
  const lines = minisignText(text)
    .split('\n')
    .map((l) => l.replace(/\r$/, ''));
  if (lines.length !== 4 || !lines[2].startsWith('trusted comment: ')) throw new Error('signature: not four minisign lines');
  const sig = base64Line(lines[1].trim(), 74, 'signature');
  const algorithm = sig.toString('latin1', 0, 2);
  if (algorithm !== 'ED') throw new Error(`signature: algorithm "${algorithm}", expected the prehashed "ED"`);
  return {
    keyId: keyIdHex(sig.subarray(2, 10)),
    signature: sig.subarray(10),
    trustedComment: lines[2].slice('trusted comment: '.length),
    globalSignature: base64Line(lines[3].trim(), 64, 'global signature'),
  };
}

/** The tab-separated `key:value` fields of a trusted comment (timestamp, file, version). */
export function trustedFields(comment: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of comment.split('\t')) {
    const at = part.indexOf(':');
    if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1);
  }
  return fields;
}

function ed25519Key(raw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
}

/**
 * Checks the global signature only (key id, trusted comment): what can be checked without the file. Returns the
 * trusted comment's fields; throws when anything is off.
 */
export function verifyTrusted(publicKey: string | MinisignPublicKey, signature: string | MinisignSignature): Record<string, string> {
  const pub = typeof publicKey === 'string' ? parsePublicKey(publicKey) : publicKey;
  const sig = typeof signature === 'string' ? parseSignature(signature) : signature;
  if (sig.keyId !== pub.keyId) throw new Error(`signed with key ${sig.keyId}, not ${pub.keyId}`);
  const signed = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]);
  if (!crypto.verify(null, signed, ed25519Key(pub.key), sig.globalSignature)) throw new Error('the trusted comment does not match its signature');
  return trustedFields(sig.trustedComment);
}

/**
 * Verifies `signature` over `data` (the file's bytes, or { file } to stream one from disk: the server tarball is
 * ~100 MB) with `publicKey`, as tauri-plugin-updater does. Returns the trusted comment's fields
 * ({ timestamp, file, version }); throws when anything is off.
 */
export async function verify(
  publicKey: string | MinisignPublicKey,
  signature: string | MinisignSignature,
  data: Buffer | { file: string },
): Promise<Record<string, string>> {
  const pub = typeof publicKey === 'string' ? parsePublicKey(publicKey) : publicKey;
  const sig = typeof signature === 'string' ? parseSignature(signature) : signature;
  const fields = verifyTrusted(pub, sig);
  const hash = crypto.createHash('blake2b512');
  if (Buffer.isBuffer(data)) hash.update(data);
  else for await (const chunk of fs.createReadStream(data.file)) hash.update(chunk as Buffer);
  if (!crypto.verify(null, hash.digest(), ed25519Key(pub.key), sig.signature)) throw new Error('the file does not match its signature');
  return fields;
}

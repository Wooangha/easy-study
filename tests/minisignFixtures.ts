// Throwaway minisign keys and signatures for tests (server/minisign.ts, server/selfUpdate.ts): an Ed25519 key from
// node:crypto, written in the formats `tauri signer` uses (minisign text, optionally wrapped in one more layer of
// base64). The real updater key is never used.
import crypto from 'node:crypto';

export interface TestKey {
  /** Key id as minisign prints it (16 upper-case hex digits). */
  keyId: string;
  /** 8 key id bytes as stored (little endian). */
  idBytes: Buffer;
  privateKey: crypto.KeyObject;
  /** The public key as tauri.conf.json holds it (base64 of the minisign text). */
  publicKey: string;
  /** The public key's minisign text. */
  publicKeyText: string;
}

/** A new throwaway key; `idBytes` fixes the key id (e.g. to reuse another key's id). */
export function makeTestKey(idBytes: Buffer = crypto.randomBytes(8)): TestKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  const keyId = Buffer.from(idBytes).reverse().toString('hex').toUpperCase();
  const publicKeyText = `untrusted comment: minisign public key: ${keyId}\n${Buffer.concat([Buffer.from('Ed'), idBytes, raw]).toString('base64')}\n`;
  return { keyId, idBytes, privateKey, publicKey: Buffer.from(publicKeyText).toString('base64'), publicKeyText };
}

export interface SignOptions {
  file: string;
  version: string;
  timestamp?: number;
  /** "ED" (prehashed, what Tauri writes) or the legacy "Ed". */
  algorithm?: 'ED' | 'Ed';
  /** Wrap the minisign text in base64 as Tauri does (default true). */
  wrap?: boolean;
}

/** A minisign signature of `data` by `key`, with the trusted comment `timestamp:…\tfile:…\tversion:…`. */
export function signTest(key: TestKey, data: Buffer, { file, version, timestamp = 1_700_000_000, algorithm = 'ED', wrap = true }: SignOptions): string {
  const signed = algorithm === 'ED' ? crypto.createHash('blake2b512').update(data).digest() : data;
  const sig = crypto.sign(null, signed, key.privateKey);
  const comment = `timestamp:${timestamp}\tfile:${file}\tversion:${version}`;
  const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(comment)]), key.privateKey);
  const text =
    'untrusted comment: signature from tauri secret key\n' +
    `${Buffer.concat([Buffer.from(algorithm, 'latin1'), key.idBytes, sig]).toString('base64')}\n` +
    `trusted comment: ${comment}\n` +
    `${global.toString('base64')}\n`;
  return wrap ? Buffer.from(text).toString('base64') : text;
}

/** `signature` (wrapped or not) with its trusted comment replaced, the global signature left as it was. */
export function editTrustedComment(signature: string, comment: string): string {
  const wrapped = !signature.startsWith('untrusted comment:');
  const text = wrapped ? Buffer.from(signature, 'base64').toString('utf8') : signature;
  const lines = text.split('\n');
  lines[2] = `trusted comment: ${comment}`;
  const edited = lines.join('\n');
  return wrapped ? Buffer.from(edited).toString('base64') : edited;
}

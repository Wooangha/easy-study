// Minisign verification of `easy-study update` (server/minisign.ts, DESIGN §26): the port of
// desktop/scripts/minisign.mjs accepts exactly what `tauri signer sign` writes with the right key and refuses
// everything else. Signatures come from a throwaway key (tests/minisignFixtures.ts), never the real one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { repoRoot } from '../server/config.ts';
import { minisignText, parsePublicKey, parseSignature, trustedFields, verify, verifyTrusted } from '../server/minisign.ts';
import { UPDATER_ENDPOINT, UPDATER_PUBKEY } from '../server/selfUpdate.ts';
import { editTrustedComment, makeTestKey, signTest } from './minisignFixtures.ts';

const NAME = 'easy-study-server-0.7.0-linux-x64.tar.gz';
const DATA = Buffer.from('a server tarball, as far as this test is concerned\n'.repeat(1000));

const tmpDirs: string[] = [];
after(async () => {
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('minisign (server/minisign.ts)', () => {
  const key = makeTestKey();
  const good = signTest(key, DATA, { file: NAME, version: '0.7.0' });

  test('a good signature verifies from bytes and from a file, wrapped or not, and returns the trusted fields', async () => {
    assert.deepEqual(await verify(key.publicKey, good, DATA), { timestamp: '1700000000', file: NAME, version: '0.7.0' });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-minisign-'));
    tmpDirs.push(dir);
    const file = path.join(dir, NAME);
    await fs.writeFile(file, DATA);
    assert.equal((await verify(key.publicKey, good, { file })).file, NAME);
    const raw = signTest(key, DATA, { file: NAME, version: '0.7.0', wrap: false });
    assert.equal((await verify(key.publicKeyText, raw, DATA)).version, '0.7.0');
    assert.equal(minisignText(good), minisignText(raw));
    assert.equal(parsePublicKey(key.publicKey).keyId, key.keyId);
    assert.equal(parseSignature(good).keyId, key.keyId);
    assert.deepEqual(verifyTrusted(key.publicKey, good), { timestamp: '1700000000', file: NAME, version: '0.7.0' });
  });

  test('a tampered file is refused', async () => {
    const tampered = Buffer.from(DATA);
    tampered[10] ^= 1;
    await assert.rejects(verify(key.publicKey, good, tampered), /the file does not match its signature/);
  });

  test('an edited trusted comment is refused', async () => {
    const edited = editTrustedComment(good, `timestamp:1700000000\tfile:${NAME}\tversion:9.9.9`);
    await assert.rejects(verify(key.publicKey, edited, DATA), /the trusted comment does not match its signature/);
    assert.throws(() => verifyTrusted(key.publicKey, edited), /trusted comment/);
  });

  test('another key id is refused', async () => {
    const other = makeTestKey();
    await assert.rejects(verify(other.publicKey, good, DATA), new RegExp(`signed with key ${key.keyId}, not ${other.keyId}`));
  });

  test('the same key id with a different key is refused', async () => {
    const impostor = makeTestKey(key.idBytes);
    assert.equal(impostor.keyId, key.keyId);
    const forged = signTest(impostor, DATA, { file: NAME, version: '0.7.0' });
    await assert.rejects(verify(key.publicKey, forged, DATA), /does not match its signature/);
  });

  test('the legacy "Ed" (not prehashed) signature is refused', async () => {
    const legacy = signTest(key, DATA, { file: NAME, version: '0.7.0', algorithm: 'Ed' });
    assert.throws(() => parseSignature(legacy), /algorithm "Ed", expected the prehashed "ED"/);
    await assert.rejects(verify(key.publicKey, legacy, DATA), /expected the prehashed "ED"/);
  });

  test('malformed texts are refused', () => {
    assert.throws(() => minisignText('not base64 at all!'), /neither minisign text nor base64/);
    assert.throws(() => minisignText(Buffer.from('hello').toString('base64')), /base64 of something other than minisign text/);
    assert.throws(() => parseSignature(key.publicKey), /not four minisign lines/);
    assert.throws(() => parsePublicKey('untrusted comment: x\nAAAA'), /public key: 3 bytes, expected 42/);
  });

  test('trusted comment fields', () => {
    assert.deepEqual(trustedFields('timestamp:1\tfile:a:b.tar.gz\tversion:0.7.0\tjunk'), { timestamp: '1', file: 'a:b.tar.gz', version: '0.7.0' });
  });
});

describe('the updater key and endpoint (server/selfUpdate.ts)', () => {
  const conf = JSON.parse(readFileSync(path.join(repoRoot(), 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8')) as {
    plugins: { updater: { pubkey: string; endpoints: string[] } };
  };

  test('UPDATER_PUBKEY is the key the desktop app trusts (key id 8428B81A03E58D53)', () => {
    assert.equal(UPDATER_PUBKEY, conf.plugins.updater.pubkey);
    assert.equal(parsePublicKey(UPDATER_PUBKEY).keyId, '8428B81A03E58D53');
  });

  test('UPDATER_ENDPOINT is the desktop app updater endpoint', () => {
    assert.equal(UPDATER_ENDPOINT, conf.plugins.updater.endpoints[0]);
  });
});

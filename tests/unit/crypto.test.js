import { describe, it, expect } from 'vitest';
import {
  ENVELOPE_TAG, PBKDF2_ITERATIONS, MIN_ITERATIONS, MAX_ITERATIONS,
  encryptText, isEncryptedEnvelope, decryptEnvelope, bytesToBase64, base64ToBytes,
} from '../../lib/crypto.js';

const FAST = MIN_ITERATIONS;

const validEnvelope = (overrides = {}) => [ENVELOPE_TAG, {
  version: 1, kdf: 'PBKDF2', hash: 'SHA-256', iterations: FAST,
  salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', data: 'AAAA', ...overrides,
}];

describe('lib/crypto', () => {
  it('encrypt then decrypt round-trips text', async () => {
    const text = JSON.stringify({ 'example.com': { 'ログイン': { memo: 'こんにちは 😀' } } });
    const envelope = await encryptText(text, 'passphrase', FAST);
    expect(await decryptEnvelope(envelope, 'passphrase')).toBe(text);
  });

  it('round-trips a payload over 1 MB at the default iterations', async () => {
    const text = 'あa'.repeat(300 * 1024);
    const envelope = await encryptText(text, 'passphrase');
    expect(envelope[1].iterations).toBe(PBKDF2_ITERATIONS);
    expect(await decryptEnvelope(JSON.parse(JSON.stringify(envelope)), 'passphrase')).toBe(text);
  }, 15000);

  it('decrypt with a wrong passphrase throws wrong-passphrase', async () => {
    const envelope = await encryptText('secret', 'right-pass', FAST);
    await expect(decryptEnvelope(envelope, 'wrong-pass')).rejects.toThrow('wrong-passphrase');
  });

  it('two encryptions of the same text differ', async () => {
    const [, a] = await encryptText('same', 'passphrase', FAST);
    const [, b] = await encryptText('same', 'passphrase', FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it('the envelope is a top-level array the old import check rejects', async () => {
    const v = JSON.parse(JSON.stringify(await encryptText('{}', 'passphrase', FAST)));
    expect(typeof v !== 'object' || Array.isArray(v)).toBe(true);
    expect(v[0]).toBe(ENVELOPE_TAG);
    expect(isEncryptedEnvelope(v)).toBe(true);
  });

  it('isEncryptedEnvelope bounds iterations', () => {
    expect(isEncryptedEnvelope(validEnvelope({ iterations: 99999 }))).toBe(false);
    expect(isEncryptedEnvelope(validEnvelope({ iterations: 100000 }))).toBe(true);
    expect(isEncryptedEnvelope(validEnvelope({ iterations: 1000000 }))).toBe(true);
    expect(isEncryptedEnvelope(validEnvelope({ iterations: 1000001 }))).toBe(false);
    expect(MAX_ITERATIONS).toBe(1000000);
  });

  it('isEncryptedEnvelope rejects other shapes', () => {
    expect(isEncryptedEnvelope({})).toBe(false);
    expect(isEncryptedEnvelope([ENVELOPE_TAG])).toBe(false);
    expect(isEncryptedEnvelope([ENVELOPE_TAG, null])).toBe(false);
    expect(isEncryptedEnvelope(validEnvelope({ version: 2 }))).toBe(false);
    expect(isEncryptedEnvelope(validEnvelope({ salt: 1 }))).toBe(false);
    expect(isEncryptedEnvelope(validEnvelope({ iterations: '100000' }))).toBe(false);
  });

  it('decryptEnvelope throws invalid for a malformed envelope', async () => {
    const { data, ...withoutData } = validEnvelope()[1];
    await expect(decryptEnvelope([ENVELOPE_TAG, withoutData], 'passphrase')).rejects.toThrow('invalid');
    await expect(decryptEnvelope(['other-tag', validEnvelope()[1]], 'passphrase')).rejects.toThrow('invalid');
    await expect(decryptEnvelope(validEnvelope({ iterations: 99999 }), 'passphrase')).rejects.toThrow('invalid');
    await expect(decryptEnvelope(validEnvelope({ salt: '!!!' }), 'passphrase')).rejects.toThrow('invalid');
  });

  it('base64 helpers round-trip bytes across chunk boundaries', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe(btoa('hi'));
  });
});

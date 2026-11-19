export const ENVELOPE_TAG = 'switch-browser-data-encrypted';
export const ENVELOPE_VERSION = 1;
export const PBKDF2_ITERATIONS = 600000;
// The upper bound keeps a crafted file from stalling the page on every passphrase attempt.
export const MIN_ITERATIONS = 100000;
export const MAX_ITERATIONS = 1000000;

const SALT_BYTES = 16;
const IV_BYTES = 12;
// String.fromCharCode.apply overflows the call stack on large arrays.
const BASE64_CHUNK = 0x8000;

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(passphrase, salt, iterations, usage) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function encryptText(text, passphrase, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, iterations, 'encrypt');
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  // A top-level array: versions before encryption reject any array on import
  // instead of merging the envelope's fields as domains.
  return [ENVELOPE_TAG, {
    version: ENVELOPE_VERSION,
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(data)),
  }];
}

export function isEncryptedEnvelope(value) {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== ENVELOPE_TAG) return false;
  const body = value[1];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  return body.version === ENVELOPE_VERSION
    && body.kdf === 'PBKDF2'
    && body.hash === 'SHA-256'
    && Number.isInteger(body.iterations)
    && body.iterations >= MIN_ITERATIONS
    && body.iterations <= MAX_ITERATIONS
    && typeof body.salt === 'string'
    && typeof body.iv === 'string'
    && typeof body.data === 'string';
}

export async function decryptEnvelope(envelope, passphrase) {
  if (!isEncryptedEnvelope(envelope)) throw new Error('invalid');
  const { iterations, salt, iv, data } = envelope[1];
  let saltBytes, ivBytes, dataBytes;
  try {
    saltBytes = base64ToBytes(salt);
    ivBytes = base64ToBytes(iv);
    dataBytes = base64ToBytes(data);
  } catch {
    throw new Error('invalid');
  }
  if (saltBytes.length !== SALT_BYTES || ivBytes.length !== IV_BYTES) throw new Error('invalid');
  const key = await deriveKey(passphrase, saltBytes, iterations, 'decrypt');
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, dataBytes);
  } catch {
    throw new Error('wrong-passphrase');
  }
  return new TextDecoder().decode(plain);
}

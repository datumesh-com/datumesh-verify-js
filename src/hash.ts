import { sha256 } from '@noble/hashes/sha2';

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** SHA-256 in lowercase hex. */
export function sha256Hex(b: Uint8Array): string {
  return toHex(sha256(b));
}

/** SPEC 9.1: first 16 hex digits of SHA-256 over the raw 32-byte public key. */
export function keyIdOf(publicKey: Uint8Array): string {
  return sha256Hex(publicKey).slice(0, 16);
}

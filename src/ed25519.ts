// Ed25519 verification as SPEC.md 10.1 step 6 requires (libsodium-strict, RFC 8032 cofactorless):
//   - S < L;
//   - A and R canonically encoded (y < p; x = 0 with the sign bit set is rejected);
//   - A and R not of small order;
//   - [S]B - [k]A, encoded, equals R byte for byte, with k = SHA-512(R || A || M) mod L.
//
// @noble/curves supplies the group arithmetic. Its own verify() with zip215:false enforces
// S < L, canonical A and R, and rejects small-order A, but it accepts small-order R and checks
// the cofactored equation [8]([S]B - R - [k]A) = 0, which accepts some signatures the
// cofactorless rule rejects. So the checks are done here, and noble's verify() is additionally
// required to succeed (it is implied by the cofactorless check; it is a second opinion only).
import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha2';

const Point = ed25519.Point;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const P = 2n ** 255n - 19n;

function le(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

function decodeStrict(b: Uint8Array): InstanceType<typeof Point> | null {
  const y = le(b) & ((1n << 255n) - 1n);
  if (y >= P) return null; // non-canonical encoding
  try {
    return Point.fromBytes(b, false); // also rejects x = 0 with the sign bit set
  } catch {
    return null;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Strict Ed25519 verification of `sig` (64 bytes) over `msg` with public key `pub` (32 bytes). */
export function verifyEd25519Strict(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {
  if (sig.length !== 64 || pub.length !== 32) return false;
  const rBytes = sig.subarray(0, 32);
  const s = le(sig.subarray(32, 64));
  if (s >= L) return false;
  const A = decodeStrict(pub);
  const R = decodeStrict(rBytes);
  if (!A || !R) return false;
  if (A.isSmallOrder() || R.isSmallOrder()) return false;
  const h = sha512(concat(rBytes, pub, msg));
  const k = le(h) % L;
  // R' = [S]B - [k]A (multiplyUnsafe accepts 0; inputs are public, so variable time is fine).
  const SB = s === 0n ? Point.ZERO : Point.BASE.multiplyUnsafe(s);
  const kA = k === 0n ? Point.ZERO : A.multiplyUnsafe(k);
  const rCheck = SB.subtract(kA).toBytes();
  if (!equalBytes(rCheck, rBytes)) return false;
  try {
    return ed25519.verify(sig, msg, pub, { zip215: false });
  } catch {
    return false;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

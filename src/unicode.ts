// Unicode 15.1 character checks for SPEC.md 3.5, from tables shipped with this library
// (src/unicode-data.ts). Nothing here calls String.prototype.normalize or uses \p{...}
// regular expressions, so results do not depend on the JavaScript engine's Unicode version.
import { ASSIGNED, CCC, COMP, DECOMP } from './unicode-data.js';

/** True when the code point is assigned in Unicode 15.1 (General_Category != Cn). */
export function isAssigned(cp: number): boolean {
  let lo = 0;
  let hi = ASSIGNED.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ASSIGNED[2 * mid]) hi = mid - 1;
    else if (cp > ASSIGNED[2 * mid + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

let cccMap: Map<number, number> | null = null;
let decompMap: Map<number, number[]> | null = null;
let compMap: Map<number, number> | null = null;

function tables(): void {
  if (cccMap) return;
  const c = new Map<number, number>();
  for (const run of CCC.split(';')) {
    const [a, b, k] = run.split(':');
    const end = parseInt(b, 16);
    for (let cp = parseInt(a, 16); cp <= end; cp++) c.set(cp, Number(k));
  }
  const d = new Map<number, number[]>();
  for (const e of DECOMP.split(';')) {
    const [cp, seq] = e.split(':');
    d.set(
      parseInt(cp, 16),
      seq.split('.').map((h) => parseInt(h, 16)),
    );
  }
  const m = new Map<number, number>();
  for (const e of COMP.split(';')) {
    const [pair, cp] = e.split(':');
    const [x, y] = pair.split('.').map((h) => parseInt(h, 16));
    m.set(x * 0x110000 + y, parseInt(cp, 16));
  }
  cccMap = c;
  decompMap = d;
  compMap = m;
}

/** Canonical combining class (Unicode 15.1). */
export function combiningClass(cp: number): number {
  tables();
  return cccMap!.get(cp) ?? 0;
}

const SBASE = 0xac00;
const LBASE = 0x1100;
const VBASE = 0x1161;
const TBASE = 0x11a7;
const LCOUNT = 19;
const VCOUNT = 21;
const TCOUNT = 28;
const NCOUNT = VCOUNT * TCOUNT;
const SCOUNT = LCOUNT * NCOUNT;

function decompose(cp: number, out: number[]): void {
  const s = cp - SBASE;
  if (s >= 0 && s < SCOUNT) {
    out.push(LBASE + Math.floor(s / NCOUNT), VBASE + Math.floor((s % NCOUNT) / TCOUNT));
    if (s % TCOUNT) out.push(TBASE + (s % TCOUNT));
    return;
  }
  const d = decompMap!.get(cp);
  if (d) out.push(...d);
  else out.push(cp);
}

function compose(a: number, b: number): number | undefined {
  const l = a - LBASE;
  if (l >= 0 && l < LCOUNT) {
    const v = b - VBASE;
    if (v >= 0 && v < VCOUNT) return SBASE + (l * VCOUNT + v) * TCOUNT;
    return undefined;
  }
  const s = a - SBASE;
  if (s >= 0 && s < SCOUNT && s % TCOUNT === 0) {
    const t = b - TBASE;
    if (t > 0 && t < TCOUNT) return a + t;
    return undefined;
  }
  return compMap!.get(a * 0x110000 + b);
}

/** Normalization Form C of a code point sequence (UAX #15), using Unicode 15.1 data. */
export function nfc(cps: readonly number[]): number[] {
  tables();
  const d: number[] = [];
  for (const cp of cps) decompose(cp, d);
  // Canonical ordering: stable sort of each run of non-starters by combining class.
  for (let i = 1; i < d.length; i++) {
    const cc = combiningClass(d[i]);
    if (cc === 0) continue;
    let j = i;
    while (j > 0) {
      const pc = combiningClass(d[j - 1]);
      if (pc <= cc) break;
      const t = d[j];
      d[j] = d[j - 1];
      d[j - 1] = t;
      j--;
    }
  }
  // Canonical composition.
  const res: number[] = [];
  let starter = -1;
  let lastCC = 0;
  for (const ch of d) {
    const cc = combiningClass(ch);
    if (starter >= 0) {
      const adjacent = res.length - 1 === starter;
      if (adjacent || (lastCC !== 0 && lastCC < cc)) {
        const c = compose(res[starter], ch);
        if (c !== undefined) {
          res[starter] = c;
          continue;
        }
      }
    }
    if (cc === 0) starter = res.length;
    lastCC = cc;
    res.push(ch);
  }
  return res;
}

/** Code points of a string (lone surrogates come out as themselves). */
export function codePoints(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out.push(0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00));
        i++;
        continue;
      }
    }
    out.push(c);
  }
  return out;
}

/** True when the string is in NFC under Unicode 15.1. */
export function isNFC(s: string): boolean {
  const cps = codePoints(s);
  // Below U+0300 every character is a starter with NFC_Quick_Check=Yes.
  if (cps.every((c) => c < 0x300)) return true;
  const n = nfc(cps);
  if (n.length !== cps.length) return false;
  for (let i = 0; i < n.length; i++) if (n[i] !== cps[i]) return false;
  return true;
}

/** True when the string contains an unpaired surrogate. */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) i++;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

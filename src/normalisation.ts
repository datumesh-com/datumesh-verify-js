// Key normalisation (SPEC.md 16.4, since spec-0.5.0): the closed list of rules and the pure check
// of a value under one of them. A value that is not canonical is rejected, never repaired.
import { DatumeshError, fail } from './errors.js';
import { checkString } from './lexical.js';
import { codePoints, decomposedCodePoints } from './unicode.js';

/** The closed list of key normalisation rules of 16.4, in the table's order. */
export const KEY_NORMALISATIONS = ['none', 'upper_ascii', 'nfc_strict', 'arabic_skeleton', 'hebrew_consonantal', 'greek_unaccented'] as const;
export type KeyNormalisation = (typeof KEY_NORMALISATIONS)[number];

/** True when `v` is a rule of the list: any rule but `none` unless `withNone`. */
export function isKeyRule(v: unknown, withNone: boolean): v is KeyNormalisation {
  return typeof v === 'string' && (KEY_NORMALISATIONS as readonly string[]).includes(v) && (withNone || v !== 'none');
}

/** Format characters (general category Cf), Unicode 15.1, as inclusive code point pairs. */
const CF: readonly number[] = [
  0xad, 0xad, 0x600, 0x605, 0x61c, 0x61c, 0x6dd, 0x6dd, 0x70f, 0x70f, 0x890, 0x891, 0x8e2, 0x8e2, 0x180e, 0x180e,
  0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x206f, 0xfeff, 0xfeff, 0xfff9, 0xfffb, 0x110bd, 0x110bd,
  0x110cd, 0x110cd, 0x13430, 0x1343f, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a, 0xe0001, 0xe0001, 0xe0020, 0xe007f,
];

/** White_Space (Unicode), inclusive pairs. */
const WHITE_SPACE: readonly number[] = [
  0x9, 0xd, 0x20, 0x20, 0x85, 0x85, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x202f, 0x205f, 0x205f, 0x3000, 0x3000,
];

const inRanges = (table: readonly number[], cp: number): boolean => {
  for (let i = 0; i < table.length; i += 2) if (cp >= table[i] && cp <= table[i + 1]) return true;
  return false;
};

const ARABIC_MARKS: readonly number[] = [
  0x610, 0x61a, 0x64b, 0x65f, 0x670, 0x670, 0x6d6, 0x6dc, 0x6df, 0x6e8, 0x6ea, 0x6ed, 0x640, 0x640,
];

const HEBREW_EXEMPT = new Set([0x5be, 0x5c0, 0x5c3, 0x5c6]);

/** Whether the code point at `i` of `cps` is one the rule forbids (16.4's table). */
function forbidden(rule: KeyNormalisation, cp: number, cps: readonly number[], i: number): boolean {
  switch (rule) {
    case 'upper_ascii':
      return cp < 0x21 || cp > 0x7e || (cp >= 0x61 && cp <= 0x7a);
    case 'nfc_strict':
      if (cp === 0x20 && i > 0 && cps[i - 1] === 0x20) return true; // a repeated space
      if (cp === 0x20 && (i === 0 || i === cps.length - 1)) return true; // a leading or trailing space
      if (inRanges(CF, cp)) return true;
      if (cp === 0x2028 || cp === 0x2029) return true;
      return inRanges(WHITE_SPACE, cp) && cp !== 0x20;
    case 'arabic_skeleton':
      return inRanges(ARABIC_MARKS, cp);
    case 'hebrew_consonantal':
      return cp >= 0x591 && cp <= 0x5c7 && !HEBREW_EXEMPT.has(cp);
    case 'greek_unaccented':
      return decomposedCodePoints(cps).some((x) => x >= 0x300 && x <= 0x36f);
    default:
      return false;
  }
}

/**
 * A pure check (16.4): `text` is canonical under `rule`, a rule of KEY_NORMALISATIONS. A key
 * value is first a string value by 3.5, under every rule (E_CANON_STRING, E_CANON_LIMIT: a control
 * character, an unassigned code point, a string not in NFC, over 1024 bytes). Then `none` accepts
 * it; every other rule rejects the empty string and its own forbidden characters with
 * E_KEY_NORMALISATION. Throws DatumeshError for a value that is not canonical, E_SCHEMA for a rule
 * outside the list, and TypeError when either argument is not a string.
 */
export function checkKeyNormalisation(rule: string, text: string): void {
  if (typeof rule !== 'string') throw new TypeError('rule must be a string');
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!(KEY_NORMALISATIONS as readonly string[]).includes(rule)) fail('E_SCHEMA', `not a key normalisation rule: ${JSON.stringify(rule)}`);
  checkString(text, '$');
  if (rule === 'none') return;
  if (text === '') fail('E_KEY_NORMALISATION', 'the empty string is not a key', '$');
  const cps = codePoints(text);
  for (let i = 0; i < cps.length; i++) {
    if (forbidden(rule as KeyNormalisation, cps[i], cps, i)) {
      fail('E_KEY_NORMALISATION', `${rule} does not allow U+${cps[i].toString(16).toUpperCase().padStart(4, '0')}`, '$');
    }
  }
}

export { DatumeshError };

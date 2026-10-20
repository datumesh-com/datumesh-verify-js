// Lexical rules of SPEC.md sections 2-3 and 8.1. Each check throws a DatumeshError with the
// code the spec assigns; where the spec does not order two checks, the order chosen is noted
// (and recorded in DEFECTS.md).
import { fail } from './errors.js';
import { codePoints, isAssigned, isNFC } from './unicode.js';
import { utf8Length } from './utf8.js';

export const LIMITS = {
  name: 64,
  function_name: 512,
  args: 32,
  number: 128,
  string: 1024,
  summary: 1024,
  body: 1048576,
  inputs: 4096,
  licence_spdx: 64,
  licence_url: 512,
  keys: 64,
} as const;

export const TYPES = ['blob', 'boolean', 'date', 'instant', 'number', 'string'] as const;
export type TypeName = (typeof TYPES)[number];
export const VALID_TIME_TYPES: readonly string[] = ['date', 'instant', 'string'];

export function isTypeName(t: unknown): t is TypeName {
  return typeof t === 'string' && (TYPES as readonly string[]).includes(t);
}

const NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** SPEC 2.2. Grammar first (`code`), then the 64-character limit (E_CANON_LIMIT). */
export function checkName(s: string, path: string, code: 'E_CANON_NAME' | 'E_CANON_ARG_NAME' = 'E_CANON_NAME'): void {
  if (!NAME_RE.test(s)) fail(code, `not a lowercase snake_case name: ${JSON.stringify(s)}`, path);
  if (s.length > LIMITS.name) fail('E_CANON_LIMIT', `name longer than ${LIMITS.name} characters`, path);
}

/** SPEC 2.4: a name that is not `asof` and does not start with `dm_`. */
export function checkArgName(s: string, path: string): void {
  checkName(s, path, 'E_CANON_ARG_NAME');
  if (s === 'asof' || s.startsWith('dm_')) fail('E_CANON_ARG_NAME', `reserved argument name ${JSON.stringify(s)}`, path);
}

/** SPEC 2.1. Every failure is E_CANON_NAME. */
export function checkDnsName(s: string, path: string): void {
  const labels = s.split('.');
  if (labels.length < 2) fail('E_CANON_NAME', `DNS name needs at least two labels: ${JSON.stringify(s)}`, path);
  for (const l of labels) {
    if (l.length < 1 || l.length > 63 || !LABEL_RE.test(l)) fail('E_CANON_NAME', `bad DNS label ${JSON.stringify(l)}`, path);
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1])) fail('E_CANON_NAME', 'top-level label is numeric', path);
  if (s.length > 253) fail('E_CANON_NAME', 'DNS name longer than 253 characters', path);
}

/** SPEC 2.3: dns-name *( "/" name ). */
export function checkNamespace(s: string, path: string): void {
  const parts = s.split('/');
  checkDnsName(parts[0], path);
  for (const seg of parts.slice(1)) checkName(seg, path);
}

/** SPEC 2.3: namespace "/" name, at most 512 characters. */
export function checkFunctionName(s: string, path: string): void {
  const i = s.lastIndexOf('/');
  if (i < 0) fail('E_CANON_NAME', `function name has no namespace: ${JSON.stringify(s)}`, path);
  checkNamespace(s.slice(0, i), path);
  checkName(s.slice(i + 1), path);
  if (s.length > LIMITS.function_name) fail('E_CANON_LIMIT', 'function name too long', path);
}

export function isHex(s: string, digits: number): boolean {
  return s.length === digits && /^[0-9a-f]*$/.test(s);
}

export function checkHex(s: string, digits: number, path: string): void {
  if (!isHex(s, digits)) fail('E_CANON_HEX', `expected ${digits} lowercase hex digits`, path);
}

/** SPEC 9.1: `<host>#<key id>`. Host failures are E_CANON_NAME, key id failures E_CANON_HEX. */
export function checkKeyRef(s: string, path: string): { host: string; id: string } {
  const i = s.indexOf('#');
  const host = i < 0 ? s : s.slice(0, i);
  checkDnsName(host, path);
  if (i < 0) fail('E_CANON_NAME', 'key reference is <host>#<key id>', path);
  const id = s.slice(i + 1);
  checkHex(id, 16, path);
  return { host, id };
}

const NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;

/** SPEC 3.1: a canonical decimal of at most 128 characters. */
export function isNumber(s: string): boolean {
  return NUMBER_RE.test(s) && s !== '-0' && s.length <= LIMITS.number;
}

/** SPEC 3.1. Grammar (E_CANON_NUMBER) before the 128-character limit (E_CANON_LIMIT). */
export function checkNumber(s: string, path: string): void {
  if (!NUMBER_RE.test(s) || s === '-0') fail('E_CANON_NUMBER', `not a canonical decimal: ${JSON.stringify(s)}`, path);
  if (s.length > LIMITS.number) fail('E_CANON_LIMIT', `number longer than ${LIMITS.number} characters`, path);
}

function isCalendarDay(y: number, m: number, d: number): boolean {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}

const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const INSTANT_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.[0-9]{6}Z$/;

export function isDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  return !!m && isCalendarDay(+m[1], +m[2], +m[3]);
}

export function isInstant(s: string): boolean {
  const m = INSTANT_RE.exec(s);
  return !!m && isCalendarDay(+m[1], +m[2], +m[3]) && +m[4] <= 23 && +m[5] <= 59 && +m[6] <= 59;
}

/** SPEC 3.2. */
export function checkDate(s: string, path: string): void {
  if (!isDate(s)) fail('E_CANON_DATE', `not a YYYY-MM-DD calendar date: ${JSON.stringify(s)}`, path);
}

/** SPEC 3.3. */
export function checkInstant(s: string, path: string): void {
  if (!isInstant(s)) fail('E_CANON_INSTANT', `not YYYY-MM-DDTHH:MM:SS.ffffffZ: ${JSON.stringify(s)}`, path);
}

/**
 * SPEC 3.5, in its order: characters, then NFC, then the UTF-8 length limit. With `body`
 * set, TAB and LF are allowed and the limit is 1 MiB (SPEC 7, `code.body`).
 */
export function checkString(s: string, path: string, opts: { body?: boolean; limit?: number } = {}): void {
  const cps = codePoints(s);
  for (const cp of cps) {
    if (cp >= 0xd800 && cp <= 0xdfff) fail('E_CANON_STRING', `surrogate code point U+${hex4(cp)}`, path);
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) {
      if (!(opts.body && (cp === 0x09 || cp === 0x0a))) fail('E_CANON_STRING', `control character U+${hex4(cp)}`, path);
    }
    if (!isAssigned(cp)) fail('E_CANON_STRING', `code point U+${hex4(cp)} is not assigned in Unicode 15.1`, path);
  }
  if (!isNFC(s)) fail('E_CANON_STRING', 'not in Normalization Form C', path);
  const limit = opts.limit ?? (opts.body ? LIMITS.body : LIMITS.string);
  if (utf8Length(s) > limit) fail('E_CANON_LIMIT', `longer than ${limit} UTF-8 bytes`, path);
}

function hex4(cp: number): string {
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

// SPEC 3.7: <sha256>:<length>:<type>/<subtype>, with RFC 6838 restricted names in lowercase.
const BLOB_RE = /^[0-9a-f]{64}:(0|[1-9][0-9]*):([a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*)$/;
const MAX_SAFE = '9007199254740991';
export const MEDIA_TYPE_MAX = 128;

/** SPEC 3.7. Grammar, then length <= 2^53 - 1, then media type <= 128 characters; all E_CANON_BLOB. */
export function checkBlob(s: string, path: string): { sha256: string; length: number; mediaType: string } {
  const m = BLOB_RE.exec(s);
  if (!m) fail('E_CANON_BLOB', `not <sha256>:<length>:<type/subtype>: ${JSON.stringify(s)}`, path);
  const len = m[1];
  if (len.length > MAX_SAFE.length || (len.length === MAX_SAFE.length && len > MAX_SAFE)) fail('E_CANON_BLOB', `length above ${MAX_SAFE}`, path);
  if (m[2].length > MEDIA_TYPE_MAX) fail('E_CANON_BLOB', `media type longer than ${MEDIA_TYPE_MAX} characters`, path);
  return { sha256: s.slice(0, 64), length: Number(len), mediaType: m[2] };
}

const SPDX_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;
export const URL_RE = /^https:\/\/[!-~]+$/;

/**
 * SPEC 8.1 `licence`: an SPDX licence identifier or an https:// URL. SPEC.md gives no grammar;
 * this follows schemas/receipt.schema.json (and the reference tool): an identifier matches
 * [A-Za-z0-9][A-Za-z0-9.+-]* (at most 64 characters), a URL is "https://" followed by one or more
 * printable ASCII characters other than space (at most 512). Grammar before length.
 */
export function checkLicence(s: string, path: string): void {
  if (s.startsWith('https://')) {
    if (!URL_RE.test(s)) fail('E_CANON_LICENCE', 'licence URL has characters outside printable ASCII', path);
    if (s.length > LIMITS.licence_url) fail('E_CANON_LIMIT', 'licence URL too long', path);
    return;
  }
  if (!SPDX_RE.test(s)) fail('E_CANON_LICENCE', `not an SPDX identifier or https URL: ${JSON.stringify(s)}`, path);
  if (s.length > LIMITS.licence_spdx) fail('E_CANON_LIMIT', 'licence identifier too long', path);
}

/** Value of a typed scalar against its (known) type: JSON type first, then the lexical form. */
export function checkTypedValue(type: TypeName, value: unknown, path: string): void {
  if (type === 'boolean') {
    if (typeof value !== 'boolean') fail('E_CANON_TYPE', 'boolean value must be JSON true or false', path);
    return;
  }
  if (typeof value !== 'string') fail('E_CANON_TYPE', `${type} value must be a JSON string`, path);
  if (type === 'number') checkNumber(value, path);
  else if (type === 'date') checkDate(value, path);
  else if (type === 'instant') checkInstant(value, path);
  else if (type === 'blob') checkBlob(value, path);
  else checkString(value, path);
}

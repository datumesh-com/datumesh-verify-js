// Strict JSON parsing (SPEC.md 6.1, I-JSON / RFC 7493). JSON.parse is not used: it accepts
// duplicate members (last wins) and lone surrogates, both of which must be rejected.
import { fail } from './errors.js';
import { hasLoneSurrogate } from './unicode.js';
import { utf8Decode } from './utf8.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Nesting deeper than this is rejected with E_PARSE_JSON. SPEC.md sets no depth limit; this is
 * an implementation limit (Datumesh objects nest at most five levels) that keeps parsing and
 * canonicalisation from exhausting the call stack.
 */
export const MAX_DEPTH = 1000;

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function newObject(): JsonObject {
  return Object.create(null) as JsonObject;
}

export function has(o: JsonObject, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** Member names in JCS order (UTF-16 code units, which is JavaScript's default sort). */
export function sortedKeys(o: JsonObject): string[] {
  return Object.keys(o).sort();
}

export function memberPath(path: string, name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `${path}.${name}` : `${path}[${JSON.stringify(name)}]`;
}

class Parser {
  private i = 0;
  /** Path of the first string holding an escaped lone surrogate; reported after parsing. */
  surrogatePath: string | null = null;
  constructor(private readonly s: string) {}

  private err(msg: string): never {
    fail('E_PARSE_JSON', `${msg} at offset ${this.i}`, '$');
  }

  private ws(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else break;
    }
  }

  parseDocument(): JsonValue {
    this.ws();
    const v = this.value('$', 0);
    this.ws();
    if (this.i !== this.s.length) this.err('unexpected data after the JSON value');
    return v;
  }

  private value(path: string, depth: number): JsonValue {
    if (depth > MAX_DEPTH) this.err(`nesting deeper than ${MAX_DEPTH} levels (implementation limit)`);
    const s = this.s;
    const c = s[this.i];
    if (c === '{') return this.object(path, depth);
    if (c === '[') return this.array(path, depth);
    if (c === '"') return this.string(path);
    if (c === 't' && s.startsWith('true', this.i)) {
      this.i += 4;
      return true;
    }
    if (c === 'f' && s.startsWith('false', this.i)) {
      this.i += 5;
      return false;
    }
    if (c === 'n' && s.startsWith('null', this.i)) {
      this.i += 4;
      return null;
    }
    if (c === '-' || (c >= '0' && c <= '9')) return this.number();
    if (c === undefined) this.err('unexpected end of input');
    if (s.startsWith('NaN', this.i) || s.startsWith('Infinity', this.i) || s.startsWith('-Infinity', this.i)) {
      this.err('NaN and Infinity are not JSON');
    }
    this.err(`unexpected character ${JSON.stringify(c)}`);
  }

  private object(path: string, depth: number): JsonObject {
    this.i++; // {
    const o = newObject();
    let dup: string | null = null;
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return o;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.err('expected a member name');
      const k = this.string(path);
      this.ws();
      if (this.s[this.i] !== ':') this.err("expected ':'");
      this.i++;
      this.ws();
      const v = this.value(memberPath(path, k), depth + 1);
      if (has(o, k)) {
        if (dup === null) dup = k;
      } else o[k] = v;
      this.ws();
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === '}') {
        this.i++;
        break;
      }
      this.err("expected ',' or '}'");
    }
    // Like an object-pairs hook, duplicates are reported once the object is complete.
    if (dup !== null) fail('E_PARSE_DUPLICATE_KEY', `duplicate member ${JSON.stringify(dup)}`, path);
    return o;
  }

  private array(path: string, depth: number): JsonValue[] {
    this.i++; // [
    const a: JsonValue[] = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return a;
    }
    for (;;) {
      this.ws();
      a.push(this.value(`${path}[${a.length}]`, depth + 1));
      this.ws();
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === ']') {
        this.i++;
        return a;
      }
      this.err("expected ',' or ']'");
    }
  }

  private string(path: string): string {
    const s = this.s;
    this.i++; // opening quote
    let out = '';
    let start = this.i;
    for (;;) {
      if (this.i >= s.length) this.err('unterminated string');
      const c = s.charCodeAt(this.i);
      if (c === 0x22) {
        out += s.slice(start, this.i);
        this.i++;
        break;
      }
      if (c < 0x20) this.err('control character in string');
      if (c === 0x5c) {
        out += s.slice(start, this.i);
        const e = s[this.i + 1];
        let ch: string;
        switch (e) {
          case '"':
            ch = '"';
            break;
          case '\\':
            ch = '\\';
            break;
          case '/':
            ch = '/';
            break;
          case 'b':
            ch = '\b';
            break;
          case 'f':
            ch = '\f';
            break;
          case 'n':
            ch = '\n';
            break;
          case 'r':
            ch = '\r';
            break;
          case 't':
            ch = '\t';
            break;
          case 'u': {
            const h = s.slice(this.i + 2, this.i + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(h)) this.err('bad \\u escape');
            ch = String.fromCharCode(parseInt(h, 16));
            this.i += 4;
            break;
          }
          default:
            this.err('bad escape');
        }
        out += ch;
        this.i += 2;
        start = this.i;
        continue;
      }
      this.i++;
    }
    if (this.surrogatePath === null && hasLoneSurrogate(out)) this.surrogatePath = path;
    return out;
  }

  private number(): number {
    const s = this.s;
    const m = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    m.lastIndex = this.i;
    const r = m.exec(s);
    if (!r || r[0] === '-' || r[0] === '') this.err('bad number');
    const text = r[0];
    // A digit right after "0" (e.g. 01) is not JSON.
    const next = s[this.i + text.length];
    if (next !== undefined && /[0-9.eE+-]/.test(next)) this.err('bad number');
    this.i += text.length;
    const n = Number(text);
    if (!Number.isFinite(n)) fail('E_PARSE_JSON', `number out of IEEE 754 range: ${text.slice(0, 40)}`, '$');
    return n;
  }
}

/** Parse JSON text strictly. */
export function parseJsonText(text: string): JsonValue {
  if (text.charCodeAt(0) === 0xfeff) fail('E_PARSE_JSON', 'byte order mark', '$');
  if (hasLoneSurrogate(text)) fail('E_PARSE_JSON', 'lone surrogate in the text', '$');
  const p = new Parser(text);
  const v = p.parseDocument();
  if (p.surrogatePath !== null) fail('E_PARSE_JSON', 'lone surrogate', p.surrogatePath);
  return v;
}

/** Parse UTF-8 JSON bytes strictly: no BOM, no invalid UTF-8. */
export function parseJsonBytes(bytes: Uint8Array): JsonValue {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('E_PARSE_JSON', 'byte order mark', '$');
  }
  const text = utf8Decode(bytes);
  if (text === null) fail('E_PARSE_JSON', 'invalid UTF-8', '$');
  return parseJsonText(text);
}

/**
 * Check an already-parsed JavaScript value against the JSON data model and return a private
 * deep copy (plain data with null-prototype objects), so later checks cannot be affected by
 * getters, prototypes or mutation. Duplicate members cannot be detected here: pass JSON text
 * or bytes for that.
 */
export function normalizeValue(v: unknown, path = '$', depth = 0): JsonValue {
  if (depth > MAX_DEPTH) fail('E_PARSE_JSON', `nesting deeper than ${MAX_DEPTH} levels (or a cycle)`, path);
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail('E_PARSE_JSON', 'NaN and Infinity are not JSON', path);
    return v;
  }
  if (typeof v === 'string') {
    if (hasLoneSurrogate(v)) fail('E_PARSE_JSON', 'lone surrogate', path);
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => normalizeValue(x, `${path}[${i}]`, depth + 1));
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) fail('E_PARSE_JSON', 'not a plain JSON object', path);
    const o = newObject();
    for (const k of Object.keys(v as object)) {
      if (hasLoneSurrogate(k)) fail('E_PARSE_JSON', 'lone surrogate in a member name', path);
      o[k] = normalizeValue((v as Record<string, unknown>)[k], memberPath(path, k), depth + 1);
    }
    return o;
  }
  fail('E_PARSE_JSON', `${typeof v} is not a JSON value`, path);
}

/** JSON text (string), UTF-8 bytes (Uint8Array) or an already-parsed value. */
export function toJson(input: unknown): JsonValue {
  if (typeof input === 'string') return parseJsonText(input);
  if (input instanceof Uint8Array) return parseJsonBytes(input);
  if (input instanceof ArrayBuffer) return parseJsonBytes(new Uint8Array(input));
  return normalizeValue(input);
}

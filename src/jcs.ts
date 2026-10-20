// RFC 8785 JSON Canonicalization Scheme. Serialisation is delegated to the `canonicalize`
// package (the RFC authors' implementation), which relies on ECMAScript JSON.stringify for
// strings and numbers and on the default (UTF-16 code unit) sort for member names, exactly as
// RFC 8785 specifies. It is only ever given values produced by ./json.ts (plain data, finite
// numbers, well-formed strings), so its toJSON/undefined handling never comes into play.
import serialize from 'canonicalize';
import type { JsonValue } from './json.js';
import { utf8Encode } from './utf8.js';

/** RFC 8785 canonical text of a JSON value. */
export function jcsText(v: JsonValue): string {
  const s = serialize(v);
  if (typeof s !== 'string') throw new Error('canonicalize returned no text');
  return s;
}

/** RFC 8785 canonical bytes (UTF-8) of a JSON value. */
export function jcsBytes(v: JsonValue): Uint8Array {
  return utf8Encode(jcsText(v));
}

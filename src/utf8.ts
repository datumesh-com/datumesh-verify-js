// Strict UTF-8 encoding and decoding, written out so results never depend on the host's
// TextDecoder (BOM handling, replacement characters) or its ICU build.

/** Encode a well-formed string as UTF-8. Lone surrogates must have been rejected already. */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** Number of UTF-8 bytes in a well-formed string. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Decode strict UTF-8 (RFC 3629): no overlong forms, no surrogates, nothing above U+10FFFF,
 * no truncated sequences. Returns null when the bytes are not UTF-8. A leading BOM is kept
 * (as U+FEFF) so the caller can reject it.
 */
export function utf8Decode(b: Uint8Array): string | null {
  let out = '';
  const parts: string[] = [];
  for (let i = 0; i < b.length; ) {
    const x = b[i];
    let cp: number;
    let need: number;
    let min: number;
    if (x < 0x80) {
      cp = x;
      need = 0;
      min = 0;
    } else if (x >= 0xc2 && x <= 0xdf) {
      cp = x & 0x1f;
      need = 1;
      min = 0x80;
    } else if (x >= 0xe0 && x <= 0xef) {
      cp = x & 0x0f;
      need = 2;
      min = 0x800;
    } else if (x >= 0xf0 && x <= 0xf4) {
      cp = x & 0x07;
      need = 3;
      min = 0x10000;
    } else return null;
    for (let k = 1; k <= need; k++) {
      const y = b[i + k];
      if (y === undefined || (y & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (y & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out += String.fromCodePoint(cp);
    if (out.length > 8192) {
      parts.push(out);
      out = '';
    }
    i += need + 1;
  }
  parts.push(out);
  return parts.join('');
}

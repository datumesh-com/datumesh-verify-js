import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const vectorsDir = join(root, 'spec', 'vectors');

export function loadVectors() {
  const vs = [];
  for (const g of readdirSync(vectorsDir).sort()) {
    for (const f of readdirSync(join(vectorsDir, g)).sort()) vs.push(JSON.parse(readFileSync(join(vectorsDir, g, f), 'utf8')));
  }
  return vs;
}

export function vector(id) {
  return JSON.parse(readFileSync(join(vectorsDir, `${id}.json`), 'utf8'));
}

export const text = (b) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
export const utf8 = (s) => new TextEncoder().encode(s);

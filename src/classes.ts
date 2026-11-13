/**
 * Classes (SPEC.md section 16, since spec-0.5.0): the class descriptor and its define-time
 * checks (16.1, 16.2), key normalisation (16.4), object keys (16.5), describe answers (16.8) and
 * the define-time check of a function (2.5, `define` vectors).
 *
 * TEST-FIRST STUBS: the signatures below are the public API the spec-0.5.0 tests call (see
 * IMPL-NOTES-0.5.0.md). Every function throws until the implementation commit replaces it.
 */
import type { TypedScalar } from './uri.js';

const notImplemented = (name: string): never => {
  throw new Error(`${name}: not implemented (spec-0.5.0)`);
};

/** The closed list of key normalisation rules of SPEC 16.4, in the table's order. */
export const KEY_NORMALISATIONS = ['none', 'upper_ascii', 'nfc_strict', 'arabic_skeleton', 'hebrew_consonantal', 'greek_unaccented'] as const;
export type KeyNormalisation = (typeof KEY_NORMALISATIONS)[number];

/** The environment a class is defined in (the `env` of a `class` vector, SPEC 11). */
export interface ClassEnv {
  /** The namespace of the definer: a namespace defines classes under itself only (E_CLASS_OWNER). */
  definer: string;
  /** Function descriptors known to define (JSON text, bytes or parsed), found by their hash. */
  functions: unknown[];
  /** Flattened class descriptors known to define (parents and interfaces), found by class hash. */
  classes: unknown[];
}

/** A defined class: the flattened descriptor's canonical text and the class hash. */
export interface ClassDefinition {
  /** Canonical bytes (6.2) of the flattened descriptor, as UTF-8 text. */
  flattened: string;
  /** SHA-256 of those bytes, lowercase hex. */
  classHash: string;
}

/** A decoded object key (16.5): the class name and its keys, each a typed scalar or a nested object. */
export interface DecodedObject {
  class: string;
  keys: { [name: string]: TypedScalar | DecodedObject };
}

/** What `checkDescribe` found: which of the two answer kinds (16.8) it checked. */
export interface DescribeResult {
  kind: 'class' | 'object';
}

/**
 * Define a class (16.2): check `descriptor` (the author's JSON text, bytes or parsed object) under
 * the class `name`, flatten it onto its parent from `env.classes`, check methods against
 * `env.functions`, and return the flattened descriptor and class hash. Throws DatumeshError with
 * the first failure in 16.1/16.2 check order.
 */
export function defineClass(descriptor: unknown, name: string, env: ClassEnv): ClassDefinition {
  void descriptor, name, env;
  return notImplemented('defineClass');
}

/** Class hash (16.1): SHA-256 of the canonical bytes of a flattened class descriptor. Checks it as 16.1 does. */
export function classHash(flattened: unknown): string {
  void flattened;
  return notImplemented('classHash');
}

/** A pure check (16.4): `text` is canonical under `rule`. Throws DatumeshError E_KEY_NORMALISATION (or E_SCHEMA for an unknown rule). */
export function checkKeyNormalisation(rule: string, text: string): void {
  void rule, text;
  notImplemented('checkKeyNormalisation');
}

/** Parse a key encoding (16.5). Throws DatumeshError E_KEY_ENCODING unless `encoding` is exactly the canonical encoding of what it decodes to. */
export function parseObjectKey(encoding: string): DecodedObject {
  void encoding;
  return notImplemented('parseObjectKey');
}

/** Format a decoded object as its one canonical key encoding (16.5). Throws DatumeshError for an object that is not well formed. */
export function formatObjectKey(object: DecodedObject): string {
  void object;
  return notImplemented('formatObjectKey');
}

/**
 * The canonical bytes (6.2) of an object `{"class", "class_hash", "keys"}` (16.5), given as JSON
 * text, bytes or a parsed object. Throws DatumeshError.
 */
export function objectJson(object: unknown): Uint8Array {
  void object;
  return notImplemented('objectJson');
}

/** Object id (16.5): SHA-256 of the object's canonical bytes, lowercase hex. */
export function objectId(object: unknown): string {
  void object;
  return notImplemented('objectId');
}

/** Short id (16.8): the first 12 hex digits of a cell id or object id (64 lowercase hex digits, else E_CANON_HEX). */
export function shortId(id: string): string {
  void id;
  return notImplemented('shortId');
}

/**
 * Check a describe answer (16.8), JSON text, bytes or a parsed object, against what the caller
 * holds: `classes`, from class name to flattened class descriptor (an object; may be empty).
 * A class answer is checked on its own: its `class_hash` is the hash of its `descriptor`, its
 * method table is that descriptor's methods. An object answer is checked on its own (its
 * `object_id` and `short_id` follow from `object`, its `call` from the object's keys), and also
 * against the held descriptor of its class when `classes` holds one with the object's
 * `class_hash` (its keys and `methods` are the class's). Throws DatumeshError E_DESCRIBE (or the
 * parse codes for text that is not strict JSON).
 */
export function checkDescribe(answer: unknown, classes: { [name: string]: unknown }): DescribeResult {
  void answer, classes;
  return notImplemented('checkDescribe');
}

/**
 * The define-time check of a function (2.5, 7): `name` is a full function name (E_CANON_NAME),
 * `descriptor` a function descriptor (the codes of canonicalising it), and a function under a
 * rooted namespace has no input under an unrooted one (E_UNROOTED_INPUT, at the first such input
 * in `inputs` order). Formula bodies' own rules (15.6) are not checked. Returns the canonical
 * bytes and function hash.
 */
export function checkDefine(descriptor: unknown, name: string): { canonical: Uint8Array; hash: string } {
  void descriptor, name;
  return notImplemented('checkDefine');
}

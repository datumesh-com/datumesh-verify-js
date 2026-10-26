/** The spec revision this library conforms to. */
export const SPEC_VERSION = 'spec-0.4.2';

/**
 * Every error code defined by SPEC.md 10.2, in the order of that table. `E_EVAL_UNAVAILABLE` and
 * `E_INPUT_SUPERSEDED` are not failures: `verify` reports them with success at level "signed"
 * (10.1 step 7.6). Since spec-0.4.1 `E_JOB_UNKNOWN` (a mesh's answer in a `bad_request`
 * envelope at a job URL, 5.5) and `E_MESH_DOC` (a result of cross-mesh resolution, 9.6) are not
 * verification results either, nor (since spec-0.4.2) `E_SLICE_AT_CELL` and `E_NAME_UNBOUND`,
 * a mesh's answers about a request.
 */
export const ERROR_CODES = [
  'E_PARSE_JSON',
  'E_PARSE_DUPLICATE_KEY',
  'E_PARSE_URI',
  'E_SCHEMA',
  'E_CANON_NAME',
  'E_CANON_ARG_NAME',
  'E_CANON_ARG_DUPLICATE',
  'E_CANON_ARG_ORDER',
  'E_CANON_PERCENT',
  'E_CANON_TYPE',
  'E_CANON_NUMBER',
  'E_CANON_UNIT',
  'E_CANON_DATE',
  'E_CANON_INSTANT',
  'E_CANON_STRING',
  'E_CANON_BLOB',
  'E_CANON_HEX',
  'E_CANON_LICENCE',
  'E_CANON_SET',
  'E_CANON_LIMIT',
  'E_SLICE',
  'E_PUBLISHER_MISMATCH',
  'E_VALID_MISMATCH',
  'E_TIME_ORDER',
  'E_ARG_UNKNOWN',
  'E_ARG_MISSING',
  'E_KEY_UNAVAILABLE',
  'E_KEY_DOC',
  'E_KEY_UNKNOWN',
  'E_KEY_NOT_VALID',
  'E_SIGNATURE',
  'E_FN_UNAVAILABLE',
  'E_FN_HASH_MISMATCH',
  'E_ARG_TYPE',
  'E_RETURN_TYPE',
  'E_INPUT_UNAVAILABLE',
  'E_INPUT_INVALID',
  'E_INPUT_UNDECLARED',
  'E_SLICE_MEMBER',
  'E_VALUE_MISMATCH',
  'E_EVAL_UNAVAILABLE',
  'E_INPUT_SUPERSEDED',
  'E_BLOB_MISMATCH',
  'E_ENVELOPE',
  'E_JOB_UNKNOWN',
  'E_MESH_DOC',
  'E_SLICE_AT_CELL',
  'E_NAME_UNBOUND',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** A Datumesh rule was broken. `code` is a SPEC.md 10.2 code; `path` locates the failure. */
export class DatumeshError extends Error {
  readonly code: ErrorCode;
  readonly path: string | null;
  readonly detail: string;
  constructor(code: ErrorCode, detail: string, path: string | null = null) {
    super(`${code}${path ? ` at ${path}` : ''}: ${detail}`);
    this.name = 'DatumeshError';
    this.code = code;
    this.path = path;
    this.detail = detail;
  }
}

/** Shorthand used throughout: throw a DatumeshError. */
export function fail(code: ErrorCode, detail: string, path: string | null = null): never {
  throw new DatumeshError(code, detail, path);
}

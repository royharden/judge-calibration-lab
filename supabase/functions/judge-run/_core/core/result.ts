// Reason-coded results. Consequential operations (import, freeze, preregister,
// look, ledger) return Result instead of throwing so callers must handle refusals.
// Throwing is reserved for programming errors (contract violations).

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

/** Standard error payload: a machine-readable reason code plus human text. */
export type Reason<R extends string = string, D = unknown> = {
  readonly reason: R;
  readonly message: string;
  readonly details?: D;
};

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Shorthand for `err({ reason, message, details })`. */
export function fail<R extends string, D = unknown>(reason: R, message: string, details?: D): Err<Reason<R, D>> {
  return details === undefined ? err({ reason, message }) : err({ reason, message, details });
}

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

/** Transform the success value; errors pass through untouched. */
export function mapResult<T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

/** Chain a fallible step. */
export function andThen<T, U, E>(r: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> {
  return r.ok ? f(r.value) : r;
}

/** Extract the value or throw (tests and scripts only; product code should branch on `ok`). */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  const e = r.error as unknown;
  const text =
    typeof e === 'object' && e !== null && 'reason' in e
      ? `${String((e as { reason: unknown }).reason)}: ${String((e as { message?: unknown }).message ?? '')}`
      : String(e);
  throw new Error(`unwrap on Err (${text})`);
}

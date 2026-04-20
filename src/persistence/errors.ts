/**
 * Typed errors emitted by the persistence module.
 *
 * Callers use `instanceof` to discriminate and react:
 *
 *   try {
 *     await persistence.boards.get(id)
 *   } catch (e) {
 *     if (e instanceof AuthError) redirectToLogin()
 *     else if (e instanceof NotFoundError) show404()
 *     else throw e
 *   }
 */

export class PersistenceError extends Error {
  readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'PersistenceError'
    this.cause = cause
  }
}

export class NetworkError extends PersistenceError {
  constructor(message = 'Network request failed', cause?: unknown) {
    super(message, cause)
    this.name = 'NetworkError'
  }
}

export class AuthError extends PersistenceError {
  constructor(message = 'User is not authenticated', cause?: unknown) {
    super(message, cause)
    this.name = 'AuthError'
  }
}

export class NotFoundError extends PersistenceError {
  constructor(message = 'Row not found', cause?: unknown) {
    super(message, cause)
    this.name = 'NotFoundError'
  }
}

export class PermissionError extends PersistenceError {
  constructor(message = 'Permission denied', cause?: unknown) {
    super(message, cause)
    this.name = 'PermissionError'
  }
}

export class ValidationError extends PersistenceError {
  constructor(message = 'Invalid input', cause?: unknown) {
    super(message, cause)
    this.name = 'ValidationError'
  }
}

/**
 * Map a raw Supabase error (PostgrestError / StorageError / AuthError shape)
 * to a typed PersistenceError subclass.
 *
 * Postgres / PostgREST error codes used:
 *   PGRST116 — no rows returned by .single()
 *   23505    — unique_violation
 *   23503    — foreign_key_violation
 *   23514    — check_violation
 *   23502    — not_null_violation
 *   42501    — insufficient_privilege (RLS denial on write)
 *
 * We also pattern-match on message strings as a fallback because
 * Supabase doesn't always surface a code (notably on Storage + Auth).
 */
export function mapSupabaseError(
  err: { code?: string; message?: string; status?: number } | null | undefined,
  context: string,
): PersistenceError {
  if (!err) {
    return new PersistenceError(`${context}: unknown error`)
  }

  const code = err.code ?? ''
  const message = err.message ?? ''
  const status = err.status

  // RLS denial / permission
  if (code === '42501' || status === 403 || /permission denied|new row violates row-level security/i.test(message)) {
    return new PermissionError(`${context}: ${message || 'permission denied'}`, err)
  }

  // Not found
  if (code === 'PGRST116' || status === 404 || /not found|no rows/i.test(message)) {
    return new NotFoundError(`${context}: ${message || 'not found'}`, err)
  }

  // Auth-related (bad JWT, missing session, etc.)
  if (status === 401 || /jwt|auth|unauthorized/i.test(message)) {
    return new AuthError(`${context}: ${message || 'not authenticated'}`, err)
  }

  // Check constraints / FK / not-null / unique
  if (
    code === '23505' ||
    code === '23503' ||
    code === '23514' ||
    code === '23502' ||
    /violates (check|foreign key|not-null|unique) constraint/i.test(message)
  ) {
    return new ValidationError(`${context}: ${message}`, err)
  }

  // Network-ish: fetch failure, abort, etc.
  if (/fetch|network|failed to send|abort|timeout/i.test(message)) {
    return new NetworkError(`${context}: ${message}`, err)
  }

  return new PersistenceError(`${context}: ${message || 'unknown error'}`, err)
}

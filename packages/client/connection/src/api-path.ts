/**
 * The /api URL prefix — single source for both halves of the web transport.
 * The node half registers this prefix on the web server.
 */

/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
export const API_PATH = '/api'

/**
 * POST creates a one-time sign-in code (`{ code, expiresAt }`) for another
 * browser; registered only when the deployment requires browser sign-in. The
 * browser requests it relative to the mount, without the leading slash.
 */
export const SIGN_IN_CODE_PATH = '/api/connection.signInCode'

/** A one-time code that signs a browser in on its first use before `expiresAt`. */
export interface SignInCode {
  readonly code: string
  /** Epoch milliseconds after which the code no longer signs in. */
  readonly expiresAt: number
}

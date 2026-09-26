/** Browser-session authentication for the Host Connection carrier. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'
import type { SignInCode } from './api-path.ts'

const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const TOKEN_QUERY = 'token'
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
const STORED_SECRET_VERSION = 1
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const PROCESS_LAUNCH_TOKENS = new WeakMap<object, string>()
const SIGN_IN_CODE_QUERY = 'code'
// Security parameters, not deployment choices: a code is as unguessable as the
// launch token (SECRET_BYTES of randomness), short-lived, and used once.
const SIGN_IN_CODE_LIFETIME_MILLISECONDS = 10 * 60 * 1000
const MAX_PENDING_SIGN_IN_CODES = 5
/**
 * Unused one-time sign-in codes (code → expiry epoch ms) per process owner, in
 * creation order. Kept beside the launch token so a Connection reload keeps a
 * code the user is about to type; a process restart discards them all.
 */
const PROCESS_SIGN_IN_CODES = new WeakMap<object, Map<string, number>>()


interface StoredSecretPayload {
  readonly version: typeof STORED_SECRET_VERSION
  readonly secret: string
}

interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function processSignInCodes(owner: object): Map<string, number> {
  let codes = PROCESS_SIGN_IN_CODES.get(owner)
  if (codes === undefined) {
    codes = new Map()
    PROCESS_SIGN_IN_CODES.set(owner, codes)
  }
  return codes
}

/** Copy of the sign-in page, which the Host renders before any client bundle loads. */
const SIGN_IN_PAGE_COPY = {
  en: {
    lang: 'en',
    title: 'Sign in to Happy-DSH',
    body: 'On a device that’s already signed in, open Settings and choose Create sign-in code. Then enter the code here.',
    label: 'Sign-in code',
    submit: 'Sign in',
    error: 'That code didn’t work. It may have expired or already been used. Create a new one and try again.',
  },
  zh: {
    lang: 'zh-CN',
    title: '登录 Happy-DSH',
    body: '在已登录的设备上打开「设置」，点「生成登录码」，再把登录码填到这里。',
    label: '登录码',
    submit: '登录',
    error: '登录码无效，可能已过期或已被使用。请重新生成后再试。',
  },
} as const

/**
 * Render the self-contained sign-in page: no scripts, no external resources,
 * one GET form that submits the code back to the index.
 * @param acceptLanguage - the request's Accept-Language header, if any.
 * @param failed - whether the request carried a code that did not sign in.
 * @returns the complete HTML document.
 */
function signInPage(acceptLanguage: string | undefined, failed: boolean): string {
  const copy = /^\s*zh\b/iu.test(acceptLanguage ?? '') ? SIGN_IN_PAGE_COPY.zh : SIGN_IN_PAGE_COPY.en
  return `<!doctype html>
<html lang="${copy.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${copy.title}</title>
<style>
:root { color-scheme: light dark; --fg: #0f1115; --muted: #5c6270; --bg: #fff; --field: #f2f3f5; --accent: #0f1115; --on-accent: #fff; --error: #c62828; }
@media (prefers-color-scheme: dark) { :root { --fg: #f2f3f5; --muted: #a0a4ad; --bg: #151517; --field: #26272b; --accent: #f2f3f5; --on-accent: #151517; --error: #ff8a80; } }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--fg); }
body { font: 17px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; padding: max(48px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left)); }
main { max-width: 400px; margin: 0 auto; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 12px; }
p { margin: 0 0 24px; color: var(--muted); }
label { display: block; font-size: 15px; font-weight: 600; margin-bottom: 8px; }
input { width: 100%; min-height: 48px; padding: 12px 14px; font: inherit; font-size: 17px; color: var(--fg); background: var(--field); border: 0; border-radius: 12px; }
button { width: 100%; min-height: 50px; margin-top: 16px; font: inherit; font-weight: 600; color: var(--on-accent); background: var(--accent); border: 0; border-radius: 12px; }
.error { margin: 16px 0 0; color: var(--error); }
</style>
</head>
<body>
<main>
<h1>${copy.title}</h1>
<p>${copy.body}</p>
<form method="get" action="./">
<label for="code">${copy.label}</label>
<input id="code" name="${SIGN_IN_CODE_QUERY}" required autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false"${failed ? ' aria-describedby="error" aria-invalid="true"' : ''}>
<button type="submit">${copy.submit}</button>
${failed ? `<p class="error" id="error" role="alert">${copy.error}</p>` : ''}
</form>
</main>
</body>
</html>
`
}

function processLaunchToken(owner: object): string {
  const existing = PROCESS_LAUNCH_TOKENS.get(owner)
  if (existing !== undefined) return existing
  const created = encodeBase64Url(randomBytes(SECRET_BYTES))
  PROCESS_LAUNCH_TOKENS.set(owner, created)
  return created
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Canonical request authority used as the cookie name and signed audience. */
function requestAuthority(headers: ConnectionTrustRequest['headers']): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) return undefined
  return decoded
}

function storedSecret(record: CredentialRecord | undefined): Buffer | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)
    || record.payload.version !== STORED_SECRET_VERSION) {
    throw new Error('client-connection: browser-session credential record has an unsupported format')
  }
  const secret = canonicalSecret(record.payload.secret)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record has an invalid secret')
  }
  return secret
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(name: string, value: string, expiresAt: number, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function encodeCookie(payload: BrowserCookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): BrowserCookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || decoded.version !== COOKIE_PAYLOAD_VERSION
    || typeof decoded.authority !== 'string'
    || !Number.isSafeInteger(decoded.issuedAt)
    || !Number.isSafeInteger(decoded.expiresAt)) return undefined
  return decoded as unknown as BrowserCookiePayload
}

async function initializeSecret(credentials: CredentialProvider): Promise<Buffer> {
  const generated: StoredSecretPayload = {
    version: STORED_SECRET_VERSION,
    secret: encodeBase64Url(randomBytes(SECRET_BYTES)),
  }
  const record = await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
    if (current !== undefined) {
      storedSecret(current)
      return Promise.resolve(undefined)
    }
    return Promise.resolve({ kind: 'grant', payload: generated })
  })
  const secret = storedSecret(record)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record was not created')
  }
  return secret
}

/**
 * Process launch-token exchange and persistent signed-cookie verification, or
 * admission without either when the deployment requires no session.
 * Connection loads the credential provider's signing secret during activation
 * and retains it for synchronous request authentication.
 */
export class BrowserAuth {
  private readonly launchToken: string
  private readonly signInCodes: Map<string, number>
  private readonly maxAgeMilliseconds: number

  private constructor(
    processOwner: object,
    private readonly secret: Buffer,
    maxAgeDays: number,
    private readonly sessionRequired: boolean,
  ) {
    this.launchToken = processLaunchToken(processOwner)
    this.signInCodes = processSignInCodes(processOwner)
    this.maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS
    if (!Number.isSafeInteger(this.maxAgeMilliseconds)
      || !Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)) {
      throw new Error('client-connection: cookieMaxAgeDays exceeds the safe timestamp range')
    }
  }

  /**
   * Initialize browser authentication and create its durable signing secret
   * when this Harness home has none.
   * @param processOwner - root application context retaining one token across Connection reloads.
   * @param credentials - persistent credential provider for the Web profile.
   * @param maxAgeDays - positive absolute browser-cookie lifetime in days.
   * @param sessionRequired - whether a browser session is required before serving the UI.
   * @returns initialized authentication owner with the process owner's launch token.
   */
  static async create(
    processOwner: object,
    credentials: CredentialProvider,
    maxAgeDays: number,
    sessionRequired: boolean,
  ): Promise<BrowserAuth> {
    return new BrowserAuth(
      processOwner,
      await initializeSecret(credentials),
      maxAgeDays,
      sessionRequired,
    )
  }

  /**
   * Add this process's launch token to the caller's application URL, or leave the
   * URL clean when no session is required.
   * @param baseUrl - clean browser URL whose authority and mount are preserved.
   * @returns the same URL carrying the process token as its sole authentication input.
   */
  authenticatedUrl(baseUrl: string): string {
    if (!this.sessionRequired) return baseUrl
    const url = new URL(baseUrl)
    url.searchParams.set(TOKEN_QUERY, this.launchToken)
    return url.href
  }

  /**
   * Decide whether a request may proceed. A deployment that does not require a
   * browser session admits every request the trust fence already accepted;
   * otherwise the request needs a valid authority-bound cookie.
   * @param request - request headers carrying Host and Cookie.
   * @returns true only for an admitted request.
   */
  admits(request: ConnectionTrustRequest): boolean {
    return this.sessionRequired ? this.isAuthenticated(request) : true
  }

  /**
   * Create a one-time sign-in code for a browser that cannot open the launch
   * URL — typically a Home Screen web app, whose cookies are separate from the
   * browser's. The code signs in exactly once, within ten minutes, through the
   * index's `?code=` query; at most five unused codes exist at once, and
   * creating another discards the oldest. Callers must already hold a session.
   * @returns the new code and its expiry.
   * @throws when this deployment requires no browser session.
   */
  createSignInCode(): SignInCode {
    if (!this.sessionRequired) {
      throw new Error('client-connection: sign-in codes need browser authentication, which this deployment turns off')
    }
    const now = Date.now()
    this.discardExpiredSignInCodes(now)
    while (this.signInCodes.size >= MAX_PENDING_SIGN_IN_CODES) {
      const oldest = this.signInCodes.keys().next()
      /* v8 ignore next -- a non-empty Map always yields its first key. */
      if (oldest.done === true) break
      this.signInCodes.delete(oldest.value)
    }
    const code = encodeBase64Url(randomBytes(SECRET_BYTES))
    const expiresAt = now + SIGN_IN_CODE_LIFETIME_MILLISECONDS
    this.signInCodes.set(code, expiresAt)
    return { code, expiresAt }
  }

  /**
   * Authenticate an index request. A valid root query token, or an unused
   * unexpired sign-in code, mints the cookie and redirects to the
   * directory-relative clean `./`; a valid cookie lets the caller serve the
   * index. Every other request is refused: a browser navigation receives the
   * sign-in page, anything else the minimal plain-text 401. A deployment that
   * does not require a browser session serves the index directly, ignoring any
   * token or code the URL still carries.
   * @param req - incoming root or configured-index request.
   * @param res - response owned when this method returns false.
   * @returns true only when the caller may serve index.html.
   */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse): boolean {
    if (!this.sessionRequired) return true
    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    const codes = url.searchParams.getAll(SIGN_IN_CODE_QUERY)
    if (tokens.length > 0 || codes.length > 0) {
      const authority = requestAuthority(req.headers)
      // One credential per request; a code is consumed only once every other
      // condition holds, so a malformed request never burns a valid code.
      if (req.method === 'GET' && url.pathname === '/' && authority !== undefined
        && tokens.length + codes.length === 1
        && (tokens.length === 1
          ? tokenMatches(tokens.join(''), this.launchToken)
          : this.redeemSignInCode(codes.join('')))) {
        this.issueSession(res, authority)
        return false
      }
      if (req.method === 'GET' && url.pathname === '/' && this.isAuthenticated(req)) {
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': './',
          'referrer-policy': 'no-referrer',
        })
        res.end()
        return false
      }
      this.writeUnauthorized(req, res, codes.length > 0)
      return false
    }
    if (this.isAuthenticated(req)) return true
    this.writeUnauthorized(req, res, false)
    return false
  }

  /**
   * Verify the authority-bound browser cookie on a Host request.
   * @param request - request headers carrying Host and Cookie.
   * @returns true only for an unexpired cookie signed by this activation's loaded secret.
   */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    const authority = requestAuthority(request.headers)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return false
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return false
    const payload = decodeCookie(value, this.secret)
    if (payload === undefined || payload.authority !== authority) return false
    const now = Date.now()
    return payload.issuedAt <= now
      && payload.expiresAt > now
      && payload.expiresAt > payload.issuedAt
      && payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds
  }

  /** Mint the authority-bound session cookie and redirect to the clean index. */
  private issueSession(res: ConnectionIndexResponse, authority: string): void {
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const value = encodeCookie({
      version: COOKIE_PAYLOAD_VERSION,
      authority,
      issuedAt,
      expiresAt,
    }, this.secret)
    res.writeHead(303, {
      'cache-control': 'no-store',
      'location': './',
      'referrer-policy': 'no-referrer',
      'set-cookie': sessionCookie(
        cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000),
      ),
    })
    res.end()
  }

  /**
   * Consume an unused, unexpired sign-in code. Each stored code is compared in
   * constant time, and a matching code is deleted whether or not it expired.
   */
  private redeemSignInCode(candidate: string): boolean {
    const now = Date.now()
    for (const [code, expiresAt] of this.signInCodes) {
      if (!tokenMatches(candidate, code)) continue
      this.signInCodes.delete(code)
      return expiresAt > now
    }
    return false
  }

  private discardExpiredSignInCodes(now: number): void {
    for (const [code, expiresAt] of this.signInCodes) {
      if (expiresAt <= now) this.signInCodes.delete(code)
    }
  }

  /**
   * Refuse an index request. A GET that accepts HTML is a browser navigation —
   * in a Home Screen web app, the only way in — so it receives the sign-in
   * page; every other request keeps the minimal plain-text 401.
   */
  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse, codeFailed: boolean): void {
    if (req.method === 'GET' && /\btext\/html\b/u.test(header(req.headers, 'accept') ?? '')) {
      res.writeHead(401, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
        'referrer-policy': 'no-referrer',
      })
      res.end(signInPage(header(req.headers, 'accept-language'), codeFailed))
      return
    }
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
  }
}

/** Browser launch-token and persistent-cookie behavior. */

import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { BrowserAuth } from '../src/browser-auth.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { RecordCredentials } from './browser-credentials.ts'

function signedCookie(store: RecordCredentials, name: string, payload: unknown): string {
  const body = typeof payload === 'string'
    ? Buffer.from(payload, 'utf8').toString('base64url')
    : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return signedBodyCookie(store, name, body)
}

function signedBodyCookie(store: RecordCredentials, name: string, body: string): string {
  const record = store.record
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('test credential store has no signing secret')
  }
  const secret: unknown = Reflect.get(record.payload, 'secret')
  if (typeof secret !== 'string') throw new Error('test credential record has no string secret')
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')
  return `${name}=v1.${body}.${signature}`
}

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
  body?: string
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

function credentials(store: RecordCredentials): CredentialProvider {
  return store as unknown as CredentialProvider
}

function createAuth(
  store: RecordCredentials,
  maxAgeDays = 30,
  processOwner: object = {},
  sessionRequired = true,
): Promise<BrowserAuth> {
  return BrowserAuth.create(processOwner, credentials(store), maxAgeDays, sessionRequired)
}

function request(url: string, authority = '127.0.0.1:3080', init?: {
  cookie?: string
  method?: string
  accept?: string
  acceptLanguage?: string
}): ConnectionIndexRequest {
  return {
    method: init?.method ?? 'GET',
    url,
    headers: {
      host: authority,
      ...init?.cookie === undefined ? {} : { cookie: init.cookie },
      ...init?.accept === undefined ? {} : { accept: init.accept },
      ...init?.acceptLanguage === undefined ? {} : { 'accept-language': init.acceptLanguage },
    },
  }
}

/** A browser navigation: what Safari and a Home Screen web app send for a page load. */
const NAVIGATION_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

/** Redeem a sign-in code the way the sign-in form submits it. */
function redeem(auth: BrowserAuth, code: string, init?: Parameters<typeof request>[2]): ResponseState {
  const res = response()
  expect(auth.authorizeIndex(request(`/?code=${encodeURIComponent(code)}`, '127.0.0.1:3080', {
    accept: NAVIGATION_ACCEPT, ...init,
  }), res.value)).toBe(false)
  return res.state
}

function exchange(
  auth: BrowserAuth,
  authority = '127.0.0.1:3080',
): { cookie: string; launchUrl: string; state: ResponseState } {
  const launchUrl = auth.authenticatedUrl(`http://${authority}`)
  const target = new URL(launchUrl)
  const res = response()
  expect(auth.authorizeIndex(request(`${target.pathname}${target.search}`, authority), res.value)).toBe(false)
  const setCookie = res.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('token exchange did not set a cookie')
  return { cookie: setCookie.split(';', 1)[0]!, launchUrl, state: res.state }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserAuth', () => {
  it('mints one process token and a persistent authority-bound cookie', async () => {
    const store = new RecordCredentials()
    const processOwner = {}
    const first = await createAuth(store, 30, processOwner)
    const login = exchange(first)

    expect(login.state).toMatchObject({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': './',
        'referrer-policy': 'no-referrer',
      },
    })
    expect(login.state.headers?.['set-cookie']).toMatch(/; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u)
    expect(login.state.headers?.['set-cookie']).not.toContain('Secure')
    expect(first.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    expect(first.isAuthenticated({
      headers: new Headers({ host: '127.0.0.1:3080', cookie: login.cookie }),
    })).toBe(true)
    expect(first.isAuthenticated({ headers: new Headers() })).toBe(false)
    expect(first.isAuthenticated(request('/', 'localhost:3080', { cookie: login.cookie }))).toBe(false)
    expect(first.isAuthenticated(request('/', '127.0.0.1:3081', { cookie: login.cookie }))).toBe(false)

    const reloaded = await createAuth(store, 30, processOwner)
    expect(reloaded.authenticatedUrl('http://127.0.0.1:3080')).toBe(login.launchUrl)
    expect(reloaded.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)

    const restarted = await createAuth(store)
    expect(new URL(restarted.authenticatedUrl('http://127.0.0.1:3080')).searchParams.get('token'))
      .not.toBe(new URL(login.launchUrl).searchParams.get('token'))
    expect(restarted.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    const staleUrl = new URL(login.launchUrl)
    const redirected = response()
    expect(restarted.authorizeIndex(request(
      `${staleUrl.pathname}${staleUrl.search}`,
      '127.0.0.1:3080',
      { cookie: login.cookie },
    ), redirected.value)).toBe(false)
    expect(redirected.state).toEqual({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': './',
        'referrer-policy': 'no-referrer',
      },
    })
  })

  it('preserves the caller authority and mount while adding only this process token', async () => {
    const auth = await createAuth(new RecordCredentials())
    const mounted = new URL(auth.authenticatedUrl('https://gateway.example/tools/dsh/'))
    expect(mounted.origin).toBe('https://gateway.example')
    expect(mounted.pathname).toBe('/tools/dsh/')
    expect([...mounted.searchParams.keys()]).toEqual(['token'])

    const loopback = new URL(auth.authenticatedUrl('http://127.0.0.1:3080/'))
    expect(loopback.origin).toBe('http://127.0.0.1:3080')
    expect(loopback.pathname).toBe('/')
    expect(loopback.searchParams.get('token')).toBe(mounted.searchParams.get('token'))

    // The proxy preserves the browser-facing Host and strips the mount.
    const token = mounted.searchParams.get('token')
    const exchanged = response()
    expect(auth.authorizeIndex(request(`/?token=${String(token)}`, 'gateway.example'), exchanged.value)).toBe(false)
    const setCookie = exchanged.state.headers?.['set-cookie']
    if (setCookie === undefined) throw new Error('mount exchange did not set a cookie')
    expect(auth.isAuthenticated(request(
      '/', 'gateway.example', { cookie: setCookie.split(';', 1)[0]! },
    ))).toBe(true)
  })

  it('accepts the cookie for index serving and gives every unauthenticated request one response', async () => {
    const auth = await createAuth(new RecordCredentials())
    const { cookie } = exchange(auth)
    const allowed = response()
    expect(auth.authorizeIndex(request('/index.html', '127.0.0.1:3080', { cookie }), allowed.value)).toBe(true)
    expect(allowed.state).toEqual({})

    for (const candidate of [
      request('/'),
      request('/?token=wrong'),
      request('/?token=wrong&token=again'),
      request('/index.html?token=wrong'),
      request(auth.authenticatedUrl('http://127.0.0.1:3080'), '127.0.0.1:3080', { method: 'HEAD' }),
    ]) {
      const denied = response()
      expect(auth.authorizeIndex(candidate, denied.value)).toBe(false)
      expect(denied.state.status).toBe(401)
      expect(denied.state.headers).toEqual({
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      })
      expect(denied.state.body).toBe(candidate.method === 'HEAD'
        ? undefined
        : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
    }
  })

  it('serves the index and admits every request when no session is required', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store, 30, {}, false)
    const clean = 'http://127.0.0.1:3080/'
    expect(auth.authenticatedUrl(clean)).toBe(clean)

    const served = response()
    expect(auth.authorizeIndex(request('/?token=stale'), served.value)).toBe(true)
    expect(served.state).toEqual({})
    expect(auth.admits(request('/'))).toBe(true)
    expect(auth.admits({ headers: new Headers() })).toBe(true)

    // The same store under the default requirement still refuses, so the mode is
    // the only difference between these two instances.
    const required = await createAuth(store)
    expect(required.admits(request('/'))).toBe(false)
    expect(required.admits(request('/', '127.0.0.1:3080', { cookie: exchange(required).cookie }))).toBe(true)
  })

  it('rejects tampering, expiry, future issuance, and a longer lifetime than configured', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { cookie } = exchange(auth)
    const [name, value] = cookie.split('=') as [string, string]

    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=broken` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=${value.slice(0, -1)}x` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=%` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie: signedBodyCookie(store, name, 'a'),
    }))).toBe(false)
    expect(auth.isAuthenticated({ headers: {} })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: 'bad host', cookie } })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: '127.0.0.1:3080' } })).toBe(false)

    const invalidPayloads: unknown[] = [
      'not json',
      null,
      { version: 2, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 1, authority: 42, issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 1, authority: '127.0.0.1:3080', issuedAt: 'now', expiresAt: Date.now() + 1000 },
      { version: 1, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: 'later' },
    ]
    for (const payload of invalidPayloads) {
      expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
        cookie: signedCookie(store, name, payload),
      }))).toBe(false)
    }

    const shorter = await createAuth(store, 1)
    expect(shorter.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-08-23T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
  })

  it('loads one secret per activation and replaces it after deletion on the next activation', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const first = exchange(auth)
    expect(store).toMatchObject({ reads: 0, modifies: 1 })

    await store.deleteRecord()
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(true)
    const sameActivation = exchange(auth)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: sameActivation.cookie }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 1 })

    const reactivated = await createAuth(store)
    const second = exchange(reactivated)
    expect(second.cookie).not.toBe(first.cookie)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(false)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: second.cookie }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 2 })
  })

  it('fails loud on an invalid owner record instead of replacing it', async () => {
    const unsupported = new RecordCredentials()
    unsupported.record = { kind: 'api-key', key: 'not-a-cookie-secret' }
    await expect(createAuth(unsupported)).rejects.toThrow(/unsupported format/u)

    const malformed = new RecordCredentials()
    malformed.record = { kind: 'grant', payload: { version: 1, secret: 'short' } }
    await expect(createAuth(malformed)).rejects.toThrow(/invalid secret/u)

    const nonString = new RecordCredentials()
    nonString.record = { kind: 'grant', payload: { version: 1, secret: 42 } }
    await expect(createAuth(nonString)).rejects.toThrow(/invalid secret/u)

    const discarded = new RecordCredentials()
    discarded.discardWrites = true
    await expect(createAuth(discarded)).rejects.toThrow(/was not created/u)

    await expect(createAuth(new RecordCredentials(), Number.MAX_SAFE_INTEGER))
      .rejects.toThrow(/safe timestamp range/u)
  })
})

describe('BrowserAuth sign-in codes', () => {
  it('signs a browser in once with a code, then refuses the same code', async () => {
    const auth = await createAuth(new RecordCredentials())
    const { code, expiresAt } = auth.createSignInCode()
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(expiresAt - Date.now()).toBeGreaterThan(9 * 60 * 1000)

    const first = redeem(auth, code)
    expect(first).toMatchObject({
      status: 303,
      headers: { 'cache-control': 'no-store', 'location': './', 'referrer-policy': 'no-referrer' },
    })
    const cookie = first.headers?.['set-cookie']?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('code exchange did not set a cookie')
    // The same session cookie the launch token mints.
    expect(first.headers?.['set-cookie']).toMatch(/; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(true)

    const again = redeem(auth, code)
    expect(again.status).toBe(401)
    expect(again.body).toContain('role="alert"')
  })

  it('expires a code ten minutes after creating it', async () => {
    vi.useFakeTimers()
    const auth = await createAuth(new RecordCredentials())
    const kept = auth.createSignInCode().code
    const expired = auth.createSignInCode().code
    const stale = auth.createSignInCode().code
    vi.advanceTimersByTime(10 * 60 * 1000 - 1)
    expect(redeem(auth, kept).status).toBe(303)
    vi.advanceTimersByTime(1)
    expect(redeem(auth, expired).status).toBe(401)
    // Creating a code after expiry discards the stale ones it finds.
    expect(redeem(auth, auth.createSignInCode().code).status).toBe(303)
    expect(redeem(auth, stale).status).toBe(401)
  })

  it('keeps at most five unused codes, dropping the oldest', async () => {
    const auth = await createAuth(new RecordCredentials())
    const codes = Array.from({ length: 6 }, () => auth.createSignInCode().code)
    expect(redeem(auth, codes[0]!).status).toBe(401)
    for (const code of codes.slice(1)) expect(redeem(auth, code).status).toBe(303)
  })

  it('does not burn a valid code on a request that cannot sign in', async () => {
    const auth = await createAuth(new RecordCredentials())
    const { code } = auth.createSignInCode()
    const token = new URL(auth.authenticatedUrl('http://127.0.0.1:3080')).searchParams.get('token')
    for (const candidate of [
      request(`/?code=${code}`, '127.0.0.1:3080', { method: 'HEAD' }),
      request(`/index.html?code=${code}`),
      request(`/?code=${code}&code=${code}`),
      request(`/?code=${code}&token=${String(token)}`),
      { method: 'GET', url: `/?code=${code}`, headers: {} },
    ]) {
      const denied = response()
      expect(auth.authorizeIndex(candidate, denied.value)).toBe(false)
      expect(denied.state.status).toBe(401)
    }
    expect(redeem(auth, code).status).toBe(303)
  })

  it('keeps codes across a Connection reload but not across a process restart', async () => {
    const store = new RecordCredentials()
    const processOwner = {}
    const first = await createAuth(store, 30, processOwner)
    const kept = first.createSignInCode().code
    const lost = first.createSignInCode().code
    expect(redeem(await createAuth(store, 30, processOwner), kept).status).toBe(303)
    expect(redeem(await createAuth(store), lost).status).toBe(401)
  })

  it('refuses to create a code when the deployment turns browser sign-in off', async () => {
    const auth = await createAuth(new RecordCredentials(), 30, {}, false)
    expect(() => auth.createSignInCode()).toThrow(/turns off/u)
  })
})

describe('BrowserAuth sign-in page', () => {
  it('answers a signed-out browser navigation with a sign-in form', async () => {
    const auth = await createAuth(new RecordCredentials())
    const res = response()
    expect(auth.authorizeIndex(request('/', '127.0.0.1:3080', { accept: NAVIGATION_ACCEPT }), res.value)).toBe(false)
    expect(res.state.status).toBe(401)
    expect(res.state.headers).toEqual({
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
    })
    const page = res.state.body ?? ''
    expect(page).toContain('<html lang="en">')
    expect(page).toContain('<h1>Sign in to Happy-DSH</h1>')
    expect(page).toContain('<form method="get" action="./">')
    expect(page).toMatch(/<input id="code" name="code" required autocomplete="one-time-code"/u)
    expect(page).not.toContain('role="alert"')
    // Self-contained: nothing to load before the user can sign in.
    expect(page).not.toMatch(/<script|<link|src=/u)
  })

  it('follows a Chinese Accept-Language', async () => {
    const auth = await createAuth(new RecordCredentials())
    const res = response()
    auth.authorizeIndex(request('/', '127.0.0.1:3080', {
      accept: NAVIGATION_ACCEPT, acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    }), res.value)
    expect(res.state.body).toContain('<html lang="zh-CN">')
    expect(res.state.body).toContain('<h1>登录 Happy-DSH</h1>')
  })

  it('explains a code that did not work', async () => {
    const auth = await createAuth(new RecordCredentials())
    const page = redeem(auth, 'not-a-code').body ?? ''
    expect(page).toContain('aria-invalid="true"')
    expect(page).toContain('That code didn’t work.')
  })
})

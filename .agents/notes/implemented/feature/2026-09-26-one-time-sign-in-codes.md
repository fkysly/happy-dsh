# Agent Note: One-time sign-in codes for browsers that cannot open the launch URL

Status: implemented

English | [中文](2026-09-26-one-time-sign-in-codes.zh.md)

## Problem

[Browser launch-token authentication](../architecture/2026-08-24-browser-token-authentication.md) signs a browser in only through the `?token=` URL that `dsh web` prints. A web app added to the iPhone Home Screen keeps its cookies separate from Safari, so signing in through Safari does not sign the app in; it has no address bar in which to open the launch URL; and a link from another app opens in the default browser rather than in the web app. An unauthenticated request received a plain-text 401 that told the user to reopen that URL. A deployment reached only from a phone therefore could not use its Home Screen app at all.

## Decision

A signed-in browser creates a one-time sign-in code, and the unauthenticated browser enters it on a sign-in page served in place of the 401.

- `BrowserAuth.createSignInCode()` returns 32 random bytes in base64url — the same strength as the launch token, so guessing needs no rate limit — valid for ten minutes and redeemable once. At most five unused codes exist; creating another discards the oldest. Codes live in memory beside the launch token, keyed by the process owner: a Connection reload keeps them, a process restart discards them.
- `authorizeIndex` redeems `GET /?code=...` exactly as it exchanges the token: the same authority-bound cookie, then a 303 to the clean `./` with `referrer-policy: no-referrer`. A request carrying more than one credential, or one that cannot sign in for another reason, never consumes a valid code.
- A refused `GET` whose `Accept` includes `text/html` receives a self-contained sign-in page — no scripts or external resources, English or Chinese by `Accept-Language` — whose form submits the code. Every other refused request keeps the plain-text 401.
- `POST /api/connection.signInCode` creates a code. It is registered only when a session is required and sits behind the existing Host/Origin fence and cookie check. The browser reaches it through `ctx.connection.createSignInCode()`, and General Settings shows it in a Sign in on another device row.

## Alternatives considered

**Show the launch token to signed-in users.** It needs no new state, but the token stays valid for the life of the process and exchanges any number of times; displaying it would turn a one-time transfer into a long-lived secret on screen.

**Short human-typed codes (for example six digits).** Easier to type on a second device, but they need attempt limits and lockout state to resist guessing on a public host. The primary flow is copy and paste between Safari and the Home Screen app on one phone, where length costs nothing.

**Device pairing initiated by the new browser** (it shows a code, a signed-in browser approves it). This avoids copying a secret, but it needs a pending-request registry, polling or a push channel to the waiting page, and an approval UI; the one-time code delivers the same result with a single endpoint.

**Passkeys.** Apple recommends them for web apps, but they need an account model, credential storage, and a secure origin that the loopback deployment does not have; they remain possible later on top of the same cookie.

## Consequences

- A Home Screen web app signs in once and keeps the 30-day cookie across service restarts and deploys.
- Deployments with `requireBrowserAuth: false` are unchanged: no route, no page, and `createSignInCode()` resolves undefined.
- Unit tests pin code strength, single use, expiry, the five-code limit, non-consuming refusals, reload and restart behavior, and the page's content negotiation; a real Loader composition in `frontend-static` covers create, sign-in page, redeem, and reuse over HTTP.

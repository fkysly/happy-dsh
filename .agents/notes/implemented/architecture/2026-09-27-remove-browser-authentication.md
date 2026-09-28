# Agent Note: Remove browser authentication

Status: implemented

English | [中文](2026-09-27-remove-browser-authentication.zh.md)

## Problem

This fork serves one operator's own clients. [Browser token authentication](2026-08-24-browser-token-authentication.md) introduced the signed session cookie to gate a browser that could already reach the Host, and [one-time sign-in codes](../feature/2026-09-26-one-time-sign-in-codes.md) were added so a Home Screen web app could get in. [Optional browser authentication](2026-09-25-optional-browser-authentication.md) then made the requirement configurable through `requireBrowserAuth` but left it on by default, so every deployment still paid the same cost: a 43-character token to carry between devices, reissued on every restart, and a login step for every new browser. The live deployment ran with the requirement on the entire time.

## Decision

Browser authentication is deleted from this fork rather than defaulted off. The removed surface is the process launch token, the signed session cookie, the login page, the one-time sign-in codes and their `POST /api/connection.signInCode` route, the `requireBrowserAuth` and `cookieMaxAgeDays` config fields, `BrowserAuth`, `ctx.connection.authenticatedUrl(...)` and `ctx.connection.createSignInCode()`, the `credentials` service injection, and `deploy/remote-access/overlays/no-browser-auth.yml`.

The Host/Origin fence in `packages/client/connection/src/api-request-trust.ts` is the only gate, and it establishes no identity. Loopback plus the configured `trustedHosts` is the complete reachability policy: `ConnectionRequestRejection` is `403 | undefined`, a request that passes the fence is admitted as the operator Peer, and no caller-supplied credential changes that outcome.

The index (`GET /`) passes that same fence. The index carries boot-injected data — the plugin roster and revisions, preferences, and the settings-account config — so an authority this deployment does not declare now receives 403 where previously only the session cookie protected it. `authorizeIndex` was re-implemented on the fence rather than deleted, and it is stricter than the cookie was for an unadmitted Host: a Host the deployment never declared cannot read the index at all.

`dsh web` prints `dsh web: http://127.0.0.1:<port>/` with no token. The `remoteWrites` derivation is unchanged (`config.remoteWrites ?? trustedHosts.length > 0`). `$DSH_HOME/.credentials.yaml` no longer stores a `client-connection/browser-session` record and still holds the provider credential refs.

## What the fence still does

The fence refuses a request in three cases: the `Host` is neither loopback nor a configured `trustedHosts` authority, `Sec-Fetch-Site: cross-site` is present, or an attached `Origin` is not exactly the request's authority. A separate media-type rule refuses an `/api` POST that does not declare `application/json` with 415 before parsing. Together they are a DNS-rebinding and cross-site defense, not an access-control system.

Any client that can reach a declared authority drives tool-capable Sessions with this process's own authority, so TLS or a tailnet ACL is the practical access control. The fence decides reachability; it never decides who is calling.

## Alternatives considered

**Flip the default to `false` and keep the seam.** This is the approach [optional browser authentication](2026-09-25-optional-browser-authentication.md) recorded. It keeps the config field, the code, and this fork's divergence from upstream in order to preserve a capability no deployment here uses, and the live deployment had never exercised it.

**Keep a durable bearer credential, for example an `Authorization` header.** It raises the same question of who is calling, adds a credential to maintain and carry, and would need its own rotation story.

**Keep the one-time codes for the Home Screen case.** With no session to mint, no browser needs to be signed in, so the codes have no work left to do.

**Keep `authorizeIndex` deleted along with the rest.** Re-implementing it on the fence is the narrower option: the index carries boot-injected data, so removing the check would have widened exposure relative to the cookie it replaced.

## Consequences

The removal deletes the browser-side credentials: no token to carry between devices, no login step, no cookie, no signing key in the credential store, and no session state in the Host. `dsh web` prints a bare readiness URL, so the installer and smoke paths read one form instead of parsing a token out of a URL.

Nothing establishes identity. A client that passes the fence is the operator, and the fence is not access control. This fork's divergence from upstream also grows: upstream still maintains this seam, so `rpc.ts`, `rpc-host.ts`, the connection READMEs, and the deploy recipes conflict on every merge.

A deployment that shares an authority with clients it does not control needs authentication again. That is a new decision and starts from a new Agent Note; it does not reinstate this code.

## Testing

- No `BrowserAuth` module and no `SIGN_IN_CODE_PATH` exist in the tree.
- `packages/client/connection/tests/node-half.host.spec.ts` pins that a fence-passing request is admitted with no session and that an untrusted authority is still refused with 403.
- `packages/host/frontend-static/tests/frontend-static.spec.ts` pins the index fence in both directions: a fence-passing `GET /` is 200, and a Host this deployment does not serve is 403.
- `deploy/remote-access/verify-ladder.sh` walks the fence against a running deployment: the three refusals, a fence-passing request admitted with no session, and the index in both directions.
- `deploy/release/preinstall-smoke.sh` treats the bare `dsh web:` URL line as readiness.

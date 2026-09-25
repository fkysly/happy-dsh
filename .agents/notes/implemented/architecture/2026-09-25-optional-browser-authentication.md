# Agent Note: Optional browser authentication

Status: implemented

English | [中文](2026-09-25-optional-browser-authentication.zh.md)

## Problem

Reaching the Web UI from a second device costs a process launch token: 43 characters printed once per process, invalidated by the next restart, and reproducible on another device only by copying the URL. The signed cookie that the token mints outlives a restart, so the recurring cost falls on every device that has no cookie yet — a phone browser, a tablet, a fresh profile — at the moment its owner wants to look at a running session. The token is a bearer credential for the complete tool-capable Host API, so it also cannot simply be written somewhere convenient.

The deployment this work exists for reaches the Web Host from a home LAN behind its own DNS and from a tailnet, and every client that can reach it belongs to the operator. For that reachable set, the exchange authenticates nobody: the network already decides who may arrive, and the token only decides which of the operator's own browsers may speak first.

## Decision

`@deepseek-ai/dsh-client-connection` gains the config field `requireBrowserAuth`, defaulting to `true`. A deployment that sets it to `false` serves the UI and admits every request that the Host/Origin fence accepts:

- `BrowserAuth.admits(request)` answers `true` without reading a cookie, and `HostConnectionService.requestRejection` therefore returns only the fence's `403`.
- `authorizeIndex` serves an index request directly, so a `?token=` a URL still carries is ignored rather than rejected.
- `authenticatedUrl` returns the URL unchanged, so startup output and `dsh web`'s printed line carry no token to treat as sensitive.

The Host/Origin fence is deliberately untouched. `isTrustedApiRequest` still refuses an authority outside `trustedHosts` or a cross-site marker with `403`, so the configured authorities remain exactly the reachable set, and a deployment that waives the session requirement states them where it already states `trustedHosts`.

Because the default stays `true`, this fork's divergence from upstream is one validated config field and one branch in `BrowserAuth`. A deployment that omits the field behaves exactly as before, including the token exchange, the cookie, and the `401`.

## Alternatives considered

**Remove the browser-session machinery entirely, leaving access open in every deployment.** The requirement was to stop paying a login cost on a trusted network, not to make the Host API identity-free everywhere the package is used; a compile-time removal also forecloses a user system, deletes behavior that upstream tests pin, and turns every future upstream sync into a conflict in a security seam.

**Keep the token but persist it or accept it in an `Authorization` header.** A durable launch token is a second long-lived credential — the reason the [browser token authentication note](2026-08-24-browser-token-authentication.md) rejected it — and would still have to be carried to each device by hand, which is the cost being removed.

**Only lengthen the cookie's life through `cookieMaxAgeDays`.** This removes the recurring cost for devices that have logged in once, and it is the right change where the reachable set is untrusted, but it leaves the first login on every new device exactly as awkward, which is the reported friction.

**Rely on a future user system instead.** A user system answers identity and attribution, which this change does not attempt; it also cannot ship from a config field. Until one exists, a deployment must choose between a token carried by hand and the network standing as the identity, and this field is that choice.

**Serve only the tailnet and let Tailscale ACLs decide.** A narrower reachable set is compatible with this field and worth doing in addition, but it does not serve a deployment whose clients reach the host over a plain LAN, where no ACL layer exists to depend on.

## Consequences

A deployment that sets `requireBrowserAuth: false` hands the complete tool-capable Host API to every client the fence admits — the same authority the process runs with — and a client that reaches an authority can ignore a certificate it does not trust, so certificate trust is not a compensating control. The fence narrows that set to the declared authorities; it does not authenticate within it. Where a tailnet carries the traffic, Tailscale ACLs become the practical access control, and a home LAN's own segmentation becomes it otherwise.

The cost of the trade is visible in the shipped defaults rather than silent: an operator who omits the field keeps authentication, the package README's Known Limitations names what disabling it gives up, and `deploy/remote-access/README.md` states the reachable set each recipe creates. The tests pin both directions — the default still answers `401` to an unauthenticated request on a trusted authority, and the waived mode admits it while still refusing an untrusted authority with `403`.

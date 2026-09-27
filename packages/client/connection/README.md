---
description: "Browser-host wire layer for the web GUI: Remote RPC, event-stream delivery with reconnect, exact Fetch routes, the /api HTTP bridge, and the browser-trust fence."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

## Summary

The package carries browser-to-Host Remote calls, exact Fetch responses, and connection generations. The Client plugin mounts `ctx.connection` with current-page loopback state, generic RPC, the active generation and its Host facts, observable recovery state, an immediate reconnect command, and the registration point for one generation source. A generation becomes visible when its source reports ready; source completion, failure, withdrawal, or an explicit stop clears it before `ConnectionController` applies its retry policy.

## Table of Contents

- [Use this package](#use-this-package)
- [Request trust](#request-trust)
- [Connection generation](#connection-generation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

A static desktop page can provide `__DSH_TRANSPORT__.streamBaseUrl` for the HTTP origin of its owned Host. The Gateway uses that origin for its WebSocket while HTTP transport remains independently selected. The Desktop shell serves the page from its own application origin and forwards its requests to the owned Host over loopback, so Connection sees a request admitted by the same fence as any other loopback client.

Unary RPC requests use JSON. A Host handler may return byte attachments that it has already separated from the JSON-compatible result value, with each attachment naming its result-relative path. Connection writes these values as multipart parts. The JSON `metadata` part contains the RPC response envelope with `null` placeholders and an attachment table recording each path, codec, and part identifier. Paths use string keys and numeric array indices; no business field name is reserved. The Client validates the envelope, `rpcId`, attachment table, and parts, then restores each byte value as an `ArrayBuffer`-backed view. Results without attachments, including base64 strings, and failures remain JSON. Logical RPC carriers return decoded native values directly. Connection does not discover binary fields or depend on Typert; the handler that owns a result protocol performs any type-directed or runtime projection before returning. Binary parameters, events, and streamed binary results are unsupported.

The browser uses HTTP POST for Remote unary calls. API Gateway owns the `/api/remote.mux` WebSocket and its logical streams; shell-owned compositions provide equivalent Remote streams, including a stream's uplink, through `connection.rpc.open` without opening a WebSocket. The browser plugin reads the page transport, recovery settings, and location, then delegates to `installConnection(ctx, options)`. A composition that owns its carrier may call the same installer directly; the whole-client test tier does so. Each invocation creates one Context-owned service, so several Client trees can use different carriers in one realm. The Host half always provides the carrier-neutral RPC and exact `GET`/`HEAD`/`POST` route registries. When a Web carrier is present it also owns the sole `/api` route, Fetch bridge, and Host/Origin checks; a shell-owned carrier dispatches the shared Fetch handler directly. Each exact route declares buffered or streaming request-body handling before the bridge reads any bytes. Typert Gateway claims generated Remote endpoints, feature packages register non-JSON responses such as Session-log downloads and raw file uploads, and unclaimed requests return 404. Loopback hostname classification remains package-internal to the browser-facing Client state. Browser raw-body transfer is provided by [`dsh-client-file-upload`](../file-upload/README.md).

-----

<a id="request-trust"></a>
## Request trust

This package carries no browser authentication: no launch token, no session cookie, no login page, no one-time code, and no per-request identity. One fence decides reachability for every browser-facing request, and that fence establishes no identity of its own.

Every request passes `src/api-request-trust.ts` before dispatch. Its `Host` must be loopback or match a `trustedHosts` entry: exact on `host:port`, any port on port-less entries, both sides WHATWG-normalized. An attached `Origin` must equal that Host and `sec-fetch-site: cross-site` is refused. Malformed configured authorities fail plugin load. These checks defend DNS rebinding and cross-site browser requests; they never establish identity. `ctx.connection.requestRejection(request)` applies exactly this fence and answers `403 | undefined`; every refusal is 403. `dsh web --host 0.0.0.0` remains unsupported. Decision records: [browser request trust](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md) and [browser authentication removal](../../../.agents/notes/implemented/architecture/2026-09-27-remove-browser-authentication.md).

The index passes the same fence. `GET /` and the configured index path are served through `ctx.connection.authorizeIndex`, which owns the refusal: the bootstrapped index is served with 200 to a request whose Host is an authority this deployment serves, and is refused with 403 otherwise. Static assets remain public.

Every admitted request speaks for one Peer, the operator. `ctx.connection.operator` is that `PeerScope`: its `ctx` is a Cordis scope that owns connection-lifetime registrations and is disposed with the Connection. `ctx.connection.admit(request)` applies the fence and answers with `{ peer }` or `{ rejection: 403 }`; the `/api` route and the Gateway's WebSocket upgrade admit through it, and every RPC handler receives the Peer of its call. `OperatorPeer` is exported so a composition without Connection, such as the Gateway's in-process carrier, owns an operator scope with the same contract.

Admitted shared HTTP requests pass through the `connection/request` waterfall before body transfer. A listener may refuse new requests or await `next()` through response completion; removing its owning fiber removes admission behavior. Desktop uses this hook to lock new API work during an approved installation without canceling already-admitted work. Client disconnection aborts the handler signal; the bridge stops socket writes and drains any remaining response chunks. WebSocket stream ownership remains with API Gateway.

<a id="connection-generation"></a>
## Connection generation

API Gateway Client registers the internal `$events` logical stream as the sole generation source, independently of whether any `$on` listener exists. The Host attaches all incremental listeners in the API Remotes source factory, then sends one `{ type: 'ready', clientId, host: { home } }` item before events. `ConnectionController` publishes that generation and calls `onConnected` only after the ready item arrives, so baseline acquisition cannot race ahead of incremental observation.

An ended `$events` stream, a Remote stream error, a non-ready opening item, or a malformed event item invalidates the current generation. A pending handshake logs a slow-Host warning after 3 seconds and logs the readiness timeout and aborts after 15 seconds by default, including time spent waiting for the physical socket. The source must stop delivery, release resources, and settle after cancellation before a replacement starts; late readiness from a cancelled source cannot publish a generation. While the browser reports network availability, the controller publishes `connecting` and retries with 50%–100% jitter under caps of 500ms, 1s, 2s, 4s, 8s, and 10s, continuing at the final cap until recovery. Every retry asks Gateway to replace the physical WebSocket once and reopens `$events`. A page returning from a browser suspension longer than `resumeAfterHiddenMs` (30 seconds by default) reconnects as it becomes visible, because a suspended page freezes its timers and can lose its socket without an event to report it; a shorter switch away reconnects nothing. The [continuous recovery decision](../../../.agents/notes/implemented/bug-fix/2026-09-05-continuous-client-recovery.md) owns the deadlines and retry policy.

`ctx.connection.reconnect()` interrupts active work, resets the sequence, and starts retry 1 immediately. Browser `offline` aborts active work, publishes `disconnected`, and suspends automatic attempts; the next `online` transition resets the sequence and starts at the 500ms tier. Only a ready item publishes `connected`. Gateway mux owns no independent retry schedule.

Set the Host Connection row's `config.recovery` to override retry caps, the growth factor, or handshake warning and cancellation times; the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-client-connection) lists accepted fields. The Host validates these values and injects them into each served page. The Client validates the bootstrap data before providing Connection and uses those defaults when Gateway starts its loop; explicit `start()` timing overrides take precedence. The growth factor must be finite and at least one. Readiness, failure, cancellation, or a hard deadline that occurs before the warning cancels that warning. Reload the page after changing Host recovery configuration.


<a id="model-experience"></a>
## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Buffered `/api` routes retain each request body in memory** — `maxRequestBodyBytes` (default 300 MiB, sized for the default 200 MiB aggregate image limit after base64 expansion plus envelope headroom) bounds ordinary image and RPC envelopes. Opt-in streaming routes receive backpressured chunks and bypass the aggregate cap; route implementations own persistence, cancellation, and any storage quota.
- **The trust fence is the only gate, and it establishes no identity** — any client that reaches a declared authority, and can ignore a certificate it does not trust, runs commands as this user. Keep `trustedHosts` to the reachable set you would hand that authority, such as a single-operator tailnet or a home LAN.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The fence is a synchronous read of request headers against the configured authorities, so it publishes no state a companion could observe; stream/reconnect sequencing and rpcId round-trip discipline are exercised directly by behavior specs, and route register/dispose symmetry is audited by the webserver companion.

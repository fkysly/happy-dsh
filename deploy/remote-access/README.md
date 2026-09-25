# Remote access

English | [中文](README.zh.md)

How to reach the DSH Web UI from another device — a phone, a laptop, a VPS — with
authentication in front of it.

DSH already ships the authentication layer. What it does **not** ship is a
supported network deployment: the CLI refuses `--host 0.0.0.0`, the default bind
is `127.0.0.1`, and there is no TLS termination or logout. This directory closes
that gap with configuration and, where necessary, a small patch — see
[Known gaps](#known-gaps-and-what-closes-them).

**Read [Threat model](#threat-model) before choosing a recipe.** The short version:
DSH authenticates the browser with a bearer cookie that is issued **without the
`Secure` attribute**, so a plaintext transport exposes it. TLS (or a transport
that is already encrypted, such as Tailscale) is what protects it.

---

## Pick a recipe

| | **A — TLS proxy** | **B — trusted LAN** | **C — Tailscale** |
|---|---|---|---|
| Reachable from | the internet, via a proxy you run | your LAN / VPN only | your tailnet only |
| Inbound ports | 443 (or none, with DNS-01) | none | none |
| Third-party dependency | a domain + a proxy | none | Tailscale account, client on every device |
| Transport | HTTPS | plaintext | WireGuard (Tailscale) |
| Cookie protected | ✅ by TLS | ❌ sniffable on the LAN | ✅ by WireGuard |
| Core changes needed | none | none | none |
| Use when | you want it to work from anywhere, properly | the network is fully trusted and you accept the cookie risk | you already run Tailscale and every client is on it |

**Recommendation: A.** It is the only recipe that is secure by default for
arbitrary users, which matters if you are publishing this for others. B is a
deliberate downgrade — reach for it only when you control every device on the
network. C is excellent if Tailscale is already part of your life.

---

## Recipe A — TLS reverse proxy

A proxy on the same host terminates TLS and forwards to the DSH backend on
loopback. The backend port is never exposed.

```sh
dsh web --no-open --trusted-host dsh.example.com
```

That is the whole mechanism. `--trusted-host` names the authority your browser
will use, and it flows to the `/api` Host fence. `--no-open` matters because
there is nobody at the console to click a browser window.

Then start a proxy:

- **Caddy** — [`caddy/Caddyfile`](caddy/Caddyfile) for a publicly reachable host;
  [`caddy/Caddyfile.dns01-cloudflare`](caddy/Caddyfile.dns01-cloudflare) for a
  private host that still gets a publicly trusted certificate.
- **nginx** — [`nginx/dsh.conf`](nginx/dsh.conf).

If you would rather keep the authority list in version control than in your shell
history, use the file form: [`overlays/behind-proxy.yml`](overlays/behind-proxy.yml).
The flag and the file compose — the file keeps the composed expression and
concatenates its own literals, so passing both does not silently discard either.

**Also apply [`overlays/remote-browser.yml`](overlays/remote-browser.yml).** Recipe A
keeps the backend on loopback, which means the host is treated as having an
operator at its console — and two affordances then act on the *host's* desktop
instead of the browser. See [Host desktop affordances](#host-desktop-affordances).

```sh
dsh web --no-open --trusted-host dsh.example.com \
        --patch /abs/path/behind-proxy.yml \
        --patch /abs/path/remote-browser.yml
```

### Host desktop affordances

Two capabilities resolve against the machine running the server. That is correct
when the browser is on that machine and wrong when it is not:

| Affordance | What happens without the overlay |
|---|---|
| **Directory picker** | The adaptive chooser picks the `native` backend whenever the bind is loopback, the process was not launched over SSH, and the platform is macOS or Windows — the last condition being *assumed*, not probed. An OS dialog opens **on the host's screen**, which a remote browser can never answer. |
| **"Open in…"** | The button spawns a file manager or editor **on the host**. |

`overlays/remote-browser.yml` pins the picker to the `browse` backend — which
serves listing and creation over the Remote API, so the picker renders inside the
browser — and drops both halves of the "Open in…" surface.

This is a configuration change, not a core change. The bundle's own header
invites it:

> Resolve bind host, SSH launch, and display once at boot, then mount the matching
> dual-face directory picker. **Mount `-native` or `-browse` directly in an overlay
> to pin the interaction.**

**Recipe B does not need this overlay** — a non-loopback bind already resolves the
chooser to `browse` on its own. That is the one place where the *less* locked-down
recipe is the more convenient one.

### Writing overlays: two traps

Both of these fail silently or confusingly, and both bit this repository's own
files during development.

**1. A patch replaces the row's whole `config` — it does not merge.** Restate every
key the row owns. The most common casualty is `webserver.port`: omit it and the row
freezes at the schema default, quietly killing `--port`.

**2. Never replace a composed `trustedHosts` with a bare literal.** Writing

```yaml
trustedHosts: ['dsh.example.com']      # WRONG
```

discards the expression the bundle put there, so every `--trusted-host` value
disappears and the deployment refuses that authority with 403. Keep the expression
and concatenate.

**3. `!!js` takes a scalar, not a flow sequence.** `!!js [a, b]` makes the tag apply
to a sequence node and the overlay fails to parse:

```
YAMLException: unknown tag !<tag:yaml.org,2002:js>
```

Quote the whole expression instead:

```yaml
trustedHosts: !!js "[...ctx.webStartup.trustedHosts, 'dsh.example.com']"
```

### The one thing that breaks this

**The proxy must forward the browser's original `Host`.** Caddy and Traefik do
this by default; nginx needs `proxy_set_header Host $host;`.

A proxy that rewrites `Host` to the upstream makes every request fail the fence
with **403** — loudly, which is the good outcome. The failure mode to watch for
instead is a GUI that loads and then reconnects forever: that is a proxy dropping
the WebSocket upgrade for `/api/remote.mux`.

---

## Recipe B — bind the LAN, trust the LAN

```sh
dsh web --patch overlays/lan-all-interfaces.yml --no-open
```

This binds all interfaces and derives one trusted authority per non-internal IPv4
address, so LAN clients work with no further configuration.

> ⚠️ **Plaintext.** The browser-session cookie travels unencrypted, as does the
> one-time `?token=` URL. Anyone who can observe traffic on this network can
> replay the cookie and act with the full authority of an agent that runs
> commands. Only use this on a network you control end to end.

Two behaviours worth knowing:

- **`--host` becomes inert** while this overlay is applied. The patch removes the
  expression that reads it. `--port` still works.
- **On a multi-homed host, the derived trust set includes every interface** —
  a VPS gets its public address. Narrow it by restating `connection.trustedHosts`
  explicitly; the overlay file shows the shape.

---

## Recipe C — Tailscale Serve

If every client is already on your tailnet, Tailscale gives you a real certificate
and an encrypted transport without running a proxy:

```sh
tailscale serve --bg https / http://127.0.0.1:3080
dsh web --no-open --trusted-host <machine>.<tailnet>.ts.net
```

Requirements and gotchas:

- HTTPS certificates must be enabled for the tailnet (admin console → DNS).
  Until then, `tailscale cert`-backed serving fails; `tailscale status --json`
  reports `CertDomains: null`.
- Tailscale Serve proxies to loopback, so DSH keeps its default bind — no
  `--host`, no overlay.
- The certificate is for the `*.ts.net` name, so that name is the authority you
  pass to `--trusted-host`, and the name is public in Certificate Transparency
  logs (it is not a secret).
- Tailscale Serve proxies to loopback too, so **apply `remote-browser.yml`** for
  the same reason Recipe A needs it.

---

## Recipe C2 — Tailscale through a mihomo/Clash outbound

Some setups do not run the Tailscale client at all: mihomo (Clash.Meta, e.g.
behind Clash Verge) has a `tailscale` outbound type, and the machine joins the
tailnet through the proxy. Everything else stays the same — Caddy still
terminates TLS, DSH still binds loopback — but two mihomo settings that are
invisible for ordinary proxying have to be handled, and both fail in ways that
look like happy-dsh being broken.

Take this as a checklist, not a recipe: verify each step against your own
config.

**1. A domain rule, because the sniffer re-routes by name.**
With `sniffer.enable: true` and `override-destination: true`, a TLS ClientHello
on 443 has its SNI read and the rules are matched **again by domain**. An
`IP-CIDR` rule that routed the connection correctly on the way in is no longer
consulted. So a private name with no domain rule falls through to the catch-all
and gets sent to whatever proxy node is last — while SSH on 22, having no
cleartext to sniff, keeps working. That asymmetry (ssh fine, https dead) is the
signature of this.

```yaml
rules:            # or your rules profile's `prepend:`
  - DOMAIN-SUFFIX,dsh.dev,<tailscale-group>   # your tailscale outbound's group
```

**2. A hosts entry, because fake-ip is not an address.**
The tailscale outbound has to connect to a real IP. Under `enhanced-mode:
fake-ip`, mihomo's own DNS answers this name with `198.18.x.x`, which the
outbound cannot dial — so routing by domain still fails, just later. Because the
browser reaches the proxy as `CONNECT dsh.dev:443` (a **hostname**, not an IP),
this resolution has to happen on the mihomo side; a hosts file on the client
cannot help.

```yaml
hosts:
  dsh.dev: <tailnet-ip>       # the tailnet IP, not the LAN IP: no subnet
                              # route advertisement required
dns:
  use-hosts: true             # do not rely on the default
```

**3. Make sure the outbound is not expected to fall back.** A tailscale
outbound that is handed a destination outside the tailnet fails outright rather
than going direct, so the two rules above have to be the ones that match.

Verify at the end from the client, with nothing but the system proxy:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://dsh.dev/    # expect 401
curl -s -o /dev/null -w '%{http_code}\n' http://dsh.dev/     # expect 308 -> https
```

A 401 is success here: the fence accepted the authority and no session cookie
was presented. `000` means the connection never arrived.

### The same settings on iOS, where the client is Shadowrocket

Shadowrocket carries its own Tailscale outbound, so a phone or tablet joins the
tailnet the same way and meets the same three problems. It has one constraint a
desktop client does not: iOS runs a single active tunnel, so the proxy client and
the Tailscale app cannot both be connected — which is why the tailnet has to live
inside the proxy client at all.

Where C2 writes `rules:` and `hosts:` into a config file, iOS writes them into a
**module** (配置 → 模块), which outranks the active profile and survives a
subscription update:

```
[Host]
dsh.dev = <tailnet-ip>

[General]
use-local-host-item-for-proxy = true

[Rule]
DOMAIN-SUFFIX,dsh.dev,DIRECT
```

- `dsh.dev = <tailnet-ip>` maps the name to that address and skips DNS. It is
  **not** the same statement as `dsh.dev = server:<tailnet-ip>`, which asks
  that address to resolve the name. The difference is one token and the second
  form does nothing here.
- `use-local-host-item-for-proxy = true` is mandatory. Without it, a proxied
  destination is resolved on the remote node and the mapping is ignored.
- `DOMAIN-SUFFIX,…,DIRECT` is equally mandatory, and it is the half that is easy
  to leave out. A host mapping alone still leaves a tailnet destination to the
  catch-all, which hands it to a proxy node that cannot reach it: the page loads
  forever and the tunnel carries **no packets at all**. `DIRECT` sends the
  connection from the device, where the tailnet route already works.

Then set 全局路由 to 配置 and toggle the client's main switch so the tunnel
rebuilds: a module contributes rules, and the global 代理 and 直连 modes run no
rules at all, so it cannot apply under them. With all of it in place, a
capture on the tunnel shows the ClientHello arriving with **zero DNS queries**,
because the mapping is local and nothing is resolved.

Two more steps are per device and are not part of the module.

**Trust the CA in two stages.** iOS imports a `.crt` as a profile (设置 → 通用 →
VPN与设备管理) and does **not** trust it until trust is enabled separately
(设置 → 通用 → 关于本机 → 证书信任设置). Installing alone leaves exactly the state
that makes Safari report the connection is not private, which reads like a wrong
certificate. iCloud Drive distributes the file; it does not grant trust.

**Do not retype the launch token.** It is 43 characters, and a typo produces the
same `dsh web authentication required` 401 as a mismatched authority, so the
response text cannot tell the two apart. Share the URL from a device that already
has a session. To separate the causes, capture the loopback hop, where the
request line and status are clear text:

```sh
sudo tcpdump -i lo0 -n -A 'tcp port 3080'
```

The mapping above names a tailnet address, so it holds only while the tunnel is
up. The same device with the client disconnected resolves through the gateway and
needs no module — only the CA. A device that never leaves the LAN should skip the
module entirely, since a mapping to a tailnet address makes the name fail there
rather than pass through.

The `http://dsh.dev/` check above works because `curl` ignores the HSTS preload
list. Browsers do not, and `.dev` is on it, so a browser can never exercise the
plaintext hop: the request is upgraded before it leaves the device.

---

## Threat model

**What DSH's authentication is.** On `GET /`, the server exchanges the
per-process launch token (`?token=…`) for a signed cookie bound to the request's
authority — hostname and port. Every subsequent `/api` request — unary calls, the
WebSocket upgrade, generic channels — must present a Host that is loopback or
explicitly trusted, **and** that cookie. Failure is 403 (fence) or 401 (no valid
session).

**A deployment can drop the session requirement.** `requireBrowserAuth: false` on
`dsh-client-connection` — the overlay is
[`overlays/no-browser-auth.yml`](overlays/no-browser-auth.yml) — serves the UI and
admits every request the fence accepts, so `dsh web` prints a URL with no token
and no browser logs in. The fence above still decides reachability, and a
certificate is no substitute for it: any client that can reach an authority may
ignore a certificate it does not trust. Reach for it only where every client that
can reach a trusted authority is one you control.

**What it is not.** The Host/Origin fence is a confused-deputy defence against
DNS rebinding, not identity. It decides *reachability*, not *who you are*. Adding
an authority to `trustedHosts` grants no privileges by itself; it only stops the
fence from refusing that Host.

**The cookie is the bearer credential, and it has no `Secure` attribute.** DSH's
shipped transport assumes loopback HTTP, so the attribute is omitted. Consequences:

- Over **HTTPS** the cookie is encrypted in transit. Fine.
- Over **plaintext** it is readable by anyone on the path. That is Recipe B's
  entire risk.
- If you serve both an HTTPS authority and a plaintext one, the two are
  **independent cookies** — the authority is baked into both the cookie name and
  the signed payload, so leaking one does not leak the other.

**Other real properties:**

- `SameSite=Strict` — no cross-site embedding, and no cross-site request can
  trigger a state change.
- `HttpOnly` — not readable from JavaScript.
- 30-day absolute expiry by default.
- The signing key lives in DSH's credential store on the host. **Deleting it
  invalidates every session on every device** — that is your global revocation.

**The startup line is a credential, not just a URL.** On boot DSH prints

```
dsh web: http://127.0.0.1:3080/?token=<opaque>
```

That token is the only thing needed to mint a session cookie for any trusted
authority — and it is **not single-use**. The same value keeps working until the
process exits; there is no consumption, no expiry, and no per-token revocation.
Treat the line as a password:

- Do not leave it in a world-readable log. `--no-open` still prints it — that is
  how you learn the URL — so redirect stdout somewhere only you can read.
- Recipe B prints a **second copy** of the same token with the LAN address
  attached, widening the exposure.
- If it leaks, **restart the process.** That is the only remediation.

**What this directory does NOT protect against:** a compromised client device, a
compromised host, or someone who can read the host's credential store. It also
does not add rate limiting or lockout — put that at the proxy if you need it.

---

## Verification

Do not accept "the server started" as evidence. Walk the ladder. With the backend
on loopback you can drive the whole authentication path with `curl`, because the
fence and the cookie binding both read headers you control here:

```sh
B=http://127.0.0.1:3080
TOKEN=<the token from the startup line>

# 1. an untrusted Host — the DNS-rebinding fence
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Host: evil.example' -H 'Content-Type: application/json' -d '{}' "$B/api/probe"
#   expect 403

# 2. a trusted Host with no session
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Host: dsh.example.com' -H 'Origin: http://dsh.example.com' \
  -H 'Content-Type: application/json' -d '{}' "$B/api/probe"
#   expect 401

# 3. exchange the token for a cookie
curl -s -D- -o /dev/null -H 'Host: dsh.example.com' "$B/?token=$TOKEN"
#   expect 303 + Set-Cookie: dsh-auth-<hash>=...

# 4. a cookie minted for one authority must not authenticate another
#   expect 403

# 5. the right authority plus the cookie — the request is admitted
#   expect anything other than 401/403 (404 means "no such method")
```

The WebSocket carries the same decision. A refused upgrade answers a raw HTTP
status line before the socket closes:

```sh
# expect 403 without trust, 401 without a cookie, 101 with both
node -e '
const http=require("node:http"),host=process.argv[1],cookie=process.argv[2];
const req=http.request({host:"127.0.0.1",port:3080,path:"/api/remote.mux",
  headers:{Host:host,Connection:"Upgrade",Upgrade:"websocket",
    "Sec-WebSocket-Version":"13","Sec-WebSocket-Key":"dGhlIHNhbXBsZSBub25jZQ==",
    Origin:"http://"+host,...(cookie?{Cookie:cookie}:{})}});
req.on("upgrade",()=>{console.log(101);req.destroy()});
req.on("response",r=>{console.log(r.statusCode);req.destroy()});
req.end();' dsh.example.com "$COOKIE"
```

Finally, do it from a real browser through the real proxy: load the app, send a
message, open Settings. **Reading a 200 in curl is not the same as a working UI.**

---

## Known gaps and what closes them

These are honest limitations of the current state. Fixing them is the point of
this fork; each is tracked rather than hidden.

| Gap | Effect | Status |
|---|---|---|
| **Cookie has no `Secure`** | plaintext transports leak the session | planned: `connection.cookieSecure` |
| **`DSH_WEB_URL` names loopback** | on a proxy deployment the model and every shell tool are told the GUI lives at `http://127.0.0.1:<port>` — false for your browser, useless to the agent | planned: `web-runtime.config.externalUrl` |
| **No specific-IP bind** | the listen-host schema accepts only `127.0.0.1` and `0.0.0.0`, so you cannot bind one interface — Recipe C's bind would need it | planned: widen the schema |
| **A literal bind 403s everything** | related bug: the trust snapshot only derives authorities when the bind is exactly `0.0.0.0`, so binding an IP trusts nothing | planned, same change |
| **`--host` is inert under Recipe B** | flag silently does nothing | documented above |
| **No logout** | revoking one browser means deleting the host's signing key, which signs out every device | planned |
| **Forwarded headers ignored** | proxies that rewrite `Host` fail with 403; the fix is one proxy line, but a forwarded-aware mode is not implemented | deferred deliberately — a correct implementation must gate on a declared trusted peer, never trust `X-Forwarded-*` blindly |

### A note on `--host 0.0.0.0`

Upstream rejects it deliberately, with a message that names the reason: an
all-interfaces bind exposes remote code execution to the network, and until
authentication shipped there was nothing in front of it. Authentication now
exists. Recipe B still carries the plaintext-cookie risk, which is why the refusal
has not simply been deleted — the friction belongs on the blunt option, not on
every option.

---

## Quick reference

| Task | Command |
|---|---|
| Serve for a proxy | `dsh web --no-open --trusted-host <authority>` |
| Serve on the LAN | `dsh web --patch overlays/lan-all-interfaces.yml --no-open` |
| Add another authority | repeat `--trusted-host`, or list them in an overlay |
| See the composed configuration | `dsh --profile web --dump-config` |
| Diagnose 403 on everything | the proxy rewrote `Host` |
| Diagnose an iOS 401 after a working desktop login | the 43-character token was retyped — share the URL instead (Recipe C2) |
| Diagnose a GUI stuck reconnecting | the proxy is not forwarding the WebSocket upgrade |

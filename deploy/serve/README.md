# Running the Web UI as a service

English | [中文](README.zh.md)

How to keep happy-dsh running after you close the terminal, and bring it back
after a reboot — without leaking the credential it prints on startup.

This directory is about *process lifecycle*. For how to reach the Web UI from
another device (TLS, reverse proxy, LAN, Tailscale), see
[`../remote-access/`](../remote-access/).

---

## Quick start

```sh
cd deploy/serve

./install.sh --trusted-host dsh.dev

# Or, with the recommended overlay for a browser that is not on this machine:
./install.sh --trusted-host dsh.dev --port 3080 \
             --patch "$PWD/../remote-access/overlays/remote-browser.yml"
```

The script installs the service, starts it, waits for it to come up, and prints
the one-time URL to open:

```
==> Waiting for the Web UI to come up

  Ready. Open this once to mint a session cookie:

      http://127.0.0.1:3080/?token=…

  Treat this URL as a password — it stays valid until the process restarts.
```

It also creates `~/.dsh/serve.stdout` and `~/.dsh/serve.stderr` at mode 0600,
and checks that the mode actually stuck before it finishes.

---

## What ends up in your profile

`install.sh` adds two plugins to the profile **before** the service is ever
loaded, so the first boot already has them:

| plugin | what it is |
|---|---|
| `dshmarket` | the community plugin market — Settings → **Plugin Market**: browse, search, one-click install, themes, updates |
| `dsh-find-plugin` | the same catalogue inside the conversation, so the agent can search it and install what you ask for |

**Both are third-party packages**, and that is worth knowing before you accept
the default: they come from npm (`github.com/dsh-market/dsh-market`,
`github.com/awesome-dsh-plugin/dsh-find-plugin`, both MIT), not from this
repository. Neither is a dependency of the build, they update on their own
release schedule, and the market can install further plugins for you from a
[curated registry](https://awesome-dsh-plugin.com). A deployment that wants
none of that:

```sh
./install.sh --trusted-host dsh.dev --no-default-plugins

# or keep the defaults and add your own
./install.sh --trusted-host dsh.dev --plugin github:you/your-plugin
```

The order is the reason there is no second restart: `dsh plugin` initializes a
profile that does not exist yet from its shipped template, so a fresh `web`
profile arrives with `dsh-base` and `dsh-web-app` *and* these plugins in one
boot. Nothing else in the profile is touched — `add` appends to its
`package.json`.

They are ordinary profile dependencies, so `./install.sh --uninstall` leaves
them exactly where they are, with the rest of `$DSH_HOME`. To watch them
compose — the last two layers of the profile, after the bundles:

```sh
dsh --profile web --dump-config | tail -6
```

## Two ways in

| | **`install.sh`** | **`launchd/` · `systemd/`** |
|---|---|---|
| What it is | a generator | hand-written reference units |
| Use when | you want it working | you want to own the file |
| You edit | flags | the unit itself |

Both produce the same unit body. The reference files in `launchd/` and
`systemd/` are there because a generated file is opaque until you go read it —
and because `systemctl cat` / `launchctl print` showing something different
from the documentation is a bad time.

### Why the unit is generated rather than shipped as a file

Because the service needs *your* absolute paths: the `dsh` executable, the
`node` that runs it, `DSH_HOME`, the working directory. No checked-in file can
know those.

That is the dividing line across the projects this was modelled on:

| Shape | Examples | Unit comes from |
|---|---|---|
| Distro package, root, fixed paths | gitea, syncthing, code-server's `.deb`/`.rpm` | **a static file in the repo**, `systemctl enable` it |
| User-installed, lives in your home, paths vary | hermes-agent, OpenClaw, ollama's installer, Open WebUI's quadlet | **generated at install time** |

happy-dsh is the second kind. So it generates one — and ships a reference
beside it, which is what OpenClaw does.

---

## Writing your own `dsh` invocation: order matters

If you edit a reference unit or run `dsh` yourself, the argument order is not
cosmetic. Getting it wrong gives you a service that starts and dies instantly
with `error: unknown option '--patch'`.

`--patch` is a **launcher** flag (it lives in `apps/cli/src/args.ts` beside
`--profile`), while `--no-open`, `--port` and `--trusted-host` are **app**
flags owned by the `web` bundle. The launcher parses its own flags first and
stops at the first token it does not recognise:

> The launcher's flags come first and end at the first token it does not know;
> everything from there on belongs to the booted app.

So `dsh web --no-open … --patch …` fails — by the time `--patch` appears, the
launcher has already handed everything to the app, which has never heard of it.

```sh
# WRONG — the launcher stopped at --no-open
dsh web --no-open --trusted-host dsh.dev --patch remote-browser.yml

# RIGHT — launcher flags first, variadic --trusted-host last
dsh web --patch remote-browser.yml --no-open --port 3080 --trusted-host dsh.dev
```

`--trusted-host` goes last because it is declared variadic
(`<authority...>`): it swallows every following token that does not begin with a
dash. `install.sh` emits this order for you.

---

## The credential this is designed around

On boot DSH prints:

```
dsh web: http://127.0.0.1:3080/?token=<opaque>
```

That token mints a session cookie **for any trusted authority**. It is not
single-use, it does not expire, and there is no per-token revocation — it is
valid until the process exits. Anyone who reads it can drive your agent.

The default thing to do with a service's stdout is send it to the journal,
where everyone in `systemd-journal` / `adm` can read it. **Seven service units
were surveyed while designing this — gitea, syncthing ×2, code-server ×2,
ollama, OpenClaw — and not one of them sets `StandardOutput`.** So this is a
gap shared by the whole category, not a mistake peculiar to any project.

The fix is three settings, and the third is the one people miss:

```ini
StandardOutput=append:%h/.dsh/serve.stdout     # not the journal
StandardError=append:%h/.dsh/serve.stderr
UMask=0077                                      # systemd: files born 0600
```

```xml
<key>Umask</key><integer>63</integer>           <!-- launchd: 63 decimal = 0o077 -->
```

**Without the umask, the first launch on a clean machine creates those files
`0644`** — readable by every account on the box, and the launch token with it.
Pre-creating them by hand works right up until someone deletes the logs and
restarts, which is exactly when you are least likely to notice.

`install.sh` sets the umask *and* pre-creates the files at 0600. Both, on
purpose: the umask is what makes it true, and the pre-creation is what gets the
containing directory to 0700 and the ownership right before the supervisor ever
touches them.

Verified, not assumed: deleting both files and restarting the service produces
`0600`, not `0644`.

### Getting the URL back later

```sh
grep -Eo 'https?://[^ ]*token=[^ ]*' ~/.dsh/serve.stdout | tail -1
```

**You will need this less often than you expect.** The cookie's *signing key*
is persisted in `$DSH_HOME/.credentials.yaml`, so a session cookie survives a
service restart — restarting does not log you out. You only need a fresh token
when you add a device, or after you delete the signing key.

The file grows by one URL line per restart, so it stays small; truncate it any
time with `: > ~/.dsh/serve.stdout`.

Because reading a file is a poor interface, the plan is a `dsh web token
--show` command — modelled on `openclaw gateway auth-token --show`, which
deliberately **refuses redirected or piped output** so the credential cannot
silently land in a command log. Not implemented yet; it needs a core change.

---

## PATH is baked in, and that matters

The service runs with the `PATH` that was in effect when you ran `install.sh`
(or `--path` if you pass one). This is not incidental — **agent turns spawn
real shell commands**, so a service running with launchd's or systemd's minimal
default `PATH` will fail to find homebrew's `git`, or `node`, or `rg`.

So if you install a tool somewhere new, re-run `install.sh`. This is the same
sharp edge ollama's installer has, which bakes `Environment="PATH=$PATH"` from
whatever shell ran it. The alternative — curating a list — goes stale more
quietly, which is worse.

---

## Day to day

**macOS**

```sh
launchctl print  gui/$UID/ai.happy-dsh.web     # status
launchctl kickstart -k gui/$UID/ai.happy-dsh.web   # restart
launchctl bootout gui/$UID/ai.happy-dsh.web    # stop
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.happy-dsh.web.plist   # start
```

**Linux**

```sh
systemctl --user status  happy-dsh-web
systemctl --user restart happy-dsh-web
systemctl --user stop    happy-dsh-web
journalctl --user -u happy-dsh-web -f          # unit messages, not the token
```

Settings changed from the Web UI do **not** need a restart — `hmr` reloads the
profile config on its own. Plugins that need a restart will ask for one, and
the service brings it back.

### Restarting, including from inside the service

```sh
./restart.sh              # restart
./restart.sh --park       # stop, and keep it stopped
./restart.sh --dry-run    # say what it would do
```

**The common restart needs no script at all.** The unit sets `Restart=always` /
`KeepAlive=true`, so *any* exit is followed by a relaunch. A plugin that needs
a restart can simply let the process exit. That single setting is what makes
plugin-driven restarts work, and it is why there is no restart API to design.

`restart.sh` exists for the harder case: **a process running inside the service
restarting its own host.** That is not hypothetical here — an agent working on
happy-dsh runs inside happy-dsh, and a naive restart kills the caller
mid-command. So when the script detects it is inside, it does not act directly:
it re-launches itself detached, waits for the original caller to disappear, and
only then touches the service manager. On Linux that detached child would still
inherit the unit's cgroup, which `KillMode=mixed` reaches, so there it goes
through a transient `systemd-run --user` unit instead.

Verified end to end on macOS with a disposable job standing in for the service:
the job restarted itself, gaining a new pid about two seconds after the
handoff.

### Stopping, and staying stopped

Because any exit comes back, stopping means the service manager, not killing
the process:

```sh
./restart.sh --park                                  # both platforms
systemctl --user stop happy-dsh-web                  # Linux, keeps running at next login
launchctl bootout gui/$UID/ai.happy-dsh.web          # macOS, same caveat
```

`--park` is the one that lasts: it also *disables* the job, so the next login
or boot does not bring it back. A plain stop survives only until then. OpenClaw
draws the same line with `gateway stop --disable`.

---

## Uninstall

```sh
./install.sh --uninstall
```

Stops the service and removes the unit. It leaves `$DSH_HOME` alone — that
directory holds your credentials, sessions, and the cookie signing key.
Delete it yourself if you want a clean slate:

```sh
rm -rf ~/.dsh
```

---

## Where these choices come from

Almost nothing here is invented. The shapes were taken from two projects that
solved the same problems first, and both are worth reading if you are changing
this directory:

- **OpenClaw** — its `src/daemon/launchd-*.ts` is the reference implementation
  for supervising a Node server on macOS. The `Umask`/`ExitTimeOut`/
  `ProcessType` policy, the `0644`-plist-with-a-`0600`-secrets-file split, the
  detached restart handoff, the bootout-then-rebootstrap wait, and
  `stop --disable` all come from there.
- **hermes-agent** — its generated systemd unit is where the exit-code
  contract comes from: `75` means "restart me", `78` means "the config is
  broken, do not restart me", wired to `RestartForceExitStatus` /
  `RestartPreventExitStatus`. See [Known limits](#known-limits) for what is
  still missing on our side.

Two rules that are easy to lose if you edit `install.sh`:

1. **Launcher flags before app flags.** `--patch` belongs to the launcher, so
   it must precede `--no-open`. Get it wrong and the service starts and dies
   instantly.
2. **No backticks in the unit templates.** They are unquoted heredocs, so a
   backtick in a comment is command substitution — an earlier version of the
   file executed `kill` on every install because a comment said "a deliberate
   ``kill`` no longer…". Render with stderr captured and assert it is empty;
   that is what catches this.

## Known limits

Stated rather than smoothed over.

- **macOS starts at login, not at boot.** A LaunchAgent is a per-user,
  per-session job. Starting a process as you before you log in requires a
  LaunchDaemon running as root — the wrong shape for an agent that must act as
  you, with your credentials. Log in once; it stays up from there.
- **launchd throttles; it does not give up.** systemd stops after
  `StartLimitBurst` starts in `StartLimitIntervalSec` and marks the unit
  `failed`. launchd has no equivalent setting. Measured, with a job that exits
  1 immediately: it was still being respawned after 60 seconds, `runs` climbing
  2 → 3 → 5 → 6, `state` still `spawn scheduled`. So on macOS a permanently
  broken configuration retries roughly six times a minute, forever — not a
  flood, but unbounded. `KeepAlive=true` makes this matter more, not less,
  which is why the exit-code contract below is the real fix.
- **The Linux path is untested.** macOS/launchd is what has actually been run.
  The systemd unit is written from the same shape and follows hermes-agent and
  OpenClaw, but no Linux machine has run it — including the `systemd-run`
  detach in `restart.sh`. Treat it as unverified until somebody does.
- **Windows is not covered.** hermes-agent and OpenClaw both generate a
  Scheduled Task with a Startup-folder login item as the fallback when task
  creation is denied; that is the shape to copy if this is ever added.
- **There is no `dsh service install`.** A real top-level subcommand would be
  about fifteen lines beside `if (first === 'plugin')` in
  `apps/cli/src/args.ts` — but that is a core change, and `install.sh` gets the
  same result without one. The CLI rewrites a leading non-dash token into
  `--profile`, so `dsh service …` would otherwise be read as "boot a profile
  named service".
- **The exit-code contract is only two-thirds implemented.** DSH exits `0` on a
  clean stop and `1` on failure, so `Restart=always` already distinguishes them
  correctly for systemd's purposes. What is missing is `78` — "my configuration
  is broken, stop restarting me". Without it, and combined with the launchd
  behaviour above, a config typo on macOS is a slow perpetual loop rather than
  a stopped service.
- **No restart-reason reporting.** hermes-agent writes a `gateway_state.json`
  recording *why* it exited (`exit_reason: loop_liveness_watchdog`), so a
  supervised restart is not anonymous. Nothing equivalent here yet.

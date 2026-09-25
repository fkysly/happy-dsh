#!/usr/bin/env bash
#
# happy-dsh — install the Web UI as a supervised, auto-starting service.
#
#   ./install.sh --trusted-host dsh.dev
#
#   ./install.sh --trusted-host dsh.dev --port 3080 \
#                --patch "$PWD/../remote-access/overlays/remote-browser.yml"
#
#   ./install.sh --uninstall
#
# ── Why this script exists instead of a checked-in unit file ────────────────
# The service has to have *your* absolute paths baked into it — the dsh
# executable, the node that runs it, DSH_HOME, the working directory. No
# checked-in unit file can know those. Projects whose install location is fixed
# by a distro package (gitea, syncthing) can ship a static unit; a tool you
# install into your own home directory cannot. So this generates one.
#
# A hand-written reference unit is shipped beside this script for people who
# would rather edit a file than run a generator — see launchd/ and systemd/.
#
# ── The two things this does that most service units get wrong ──────────────
# 1. stdout/stderr go to a 0600 file under DSH_HOME, NOT to the journal.
#    On boot DSH prints `dsh web: http://…?token=<opaque>`. That token mints a
#    session cookie for any trusted authority, is not single-use, and stays
#    valid until the process exits. Under a supervisor the default is to route
#    stdout to the journal, where everyone in systemd-journal / adm can read it.
# 2. The log file is created 0600 *before* the supervisor opens it. Both
#    launchd and systemd create a missing log file with the default umask
#    (typically 0644), so pre-creating it is what makes (1) actually true.
#
# See README.md for the reasoning, and for how to read your URL back out.
#
# ── The two plugins this pre-installs ───────────────────────────────────────
# A happy-dsh deployment is not much use without a way to find plugins, so two
# are installed into the profile before the service is ever loaded:
#
#   dshmarket         the community plugin market (Settings → Plugin Market):
#                     browse, search, one-click install, themes, updates.
#   dsh-find-plugin   the same catalogue inside the conversation, so the agent
#                     can search it and install what you ask for.
#
# Both are third-party npm packages (MIT, from github.com/dsh-market and
# github.com/awesome-dsh-plugin), which is worth knowing before you accept the
# default: they are not part of this repository, they update on their own
# schedule, and the market can install further plugins from a curated registry.
# `--no-default-plugins` skips both; `--plugin <spec>` adds your own.

set -euo pipefail

LABEL="ai.happy-dsh.web"
SERVICE_NAME="happy-dsh-web"
PROFILE="web"
PORT=""
DSH_BIN=""
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
WORKDIR="$HOME"
SERVICE_PATH="${PATH}"
TRUSTED_HOSTS=()
PATCHES=()
PLUGINS=()
SKIP_DEFAULT_PLUGINS=0
UNINSTALL=0
PRINT_ONLY=0

# Plugins installed into the profile before the service starts. See the header
# for why these two, and what accepting them means.
#
# Exact versions, not ranges. A release ships a pair that was installed and
# booted by deploy/release/preinstall-smoke.sh, and the release workflow refuses
# to publish a stale pin — so two deployments of one release install the same
# code, and the smoke proves it about the version it names.
# `pnpm run happy-dsh:preinstall bump` moves them, this line and the two
# READMEs that quote the same pair together.
DEFAULT_PLUGINS=(dshmarket@1.65.3 dsh-find-plugin@0.4.0)

# How long the supervisor waits after SIGTERM before it SIGKILLs, in seconds.
# One number, used for launchd's ExitTimeOut, systemd's TimeoutStopSec, and the
# bootout-wait below, so the three cannot drift apart.
#
# DSH's own guarantee is the input: apps/cli/src/process-shutdown.ts declares
# PROCESS_SHUTDOWN_TIMEOUT_MS = 5000 and then force-exits. 15s is that contract
# plus margin. OpenClaw derives its budgets the same way — it caps its drain at
# 5s for launchd's 20s limit and at 315s for systemd's 330s — the difference
# being that DSH's 5s is a hard guarantee rather than a budget.
STOP_TIMEOUT=15

# launchd's own default; kept explicit so the bootout-wait has a named ceiling.
EXIT_TIMEOUT="$STOP_TIMEOUT"

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

usage() {
  cat <<'USAGE'
happy-dsh — install the Web UI as a supervised, auto-starting service.

Usage:
  install.sh --trusted-host <authority> [options]

Required:
  --trusted-host <authority>   Authority your browser will use (host or
                               host:port). Repeatable. This is what
                               `dsh web --trusted-host` takes.

Options:
  --port <n>          Listen port. Omit to use the DSH default (3080).
  --patch <path>      Overlay patch to apply. Repeatable. Pass
                      deploy/remote-access/overlays/remote-browser.yml when
                      the browser is not on this machine.
  --profile <name>    Profile to boot. Default: web
  --plugin <spec>     Extra plugin to install into the profile, as pnpm takes
                      it (`<name>`, `<name>@<version>`, `github:<owner>/<repo>`).
                      Repeatable. These add to the defaults below.
  --no-default-plugins
                      Skip the plugins this installs into the profile by
                      default — the community market (dshmarket) and the
                      in-conversation plugin finder (dsh-find-plugin). Both
                      are third-party packages; see the header of this file.
  --dsh <path>        The dsh executable. Default: `dsh` on PATH. A .js path
                      is run through node, so a repo checkout works:
                      --dsh ~/happy-dsh/apps/cli/lib/bin.js
  --dsh-home <dir>    DSH_HOME. Default: $DSH_HOME, else ~/.dsh
  --workdir <dir>     Working directory for the service. Default: $HOME
  --path <PATH>       PATH to bake into the service. Default: the PATH you
                      invoke this script with. See README "PATH is baked in".
  --label <name>      macOS launchd label.   Default: ai.happy-dsh.web
  --service <name>    Linux systemd unit.    Default: happy-dsh-web
  --print-only        Render the unit to stdout and exit without installing.
  --uninstall         Stop, unload, and remove the unit. Keeps DSH_HOME.
  -h, --help          This text.
USAGE
}

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

# systemd splits ExecStart on whitespace, so args with spaces need quoting.
# Not shell quoting — systemd's own, which understands double quotes.
sd_quote() {
  local s="$1"
  case "$s" in
    *[[:space:]]*|*'"'*|*"'"*|*'\'*)
      s="${s//\\/\\\\}"
      s="${s//\"/\\\"}"
      printf '"%s"' "$s"
      ;;
    *) printf '%s' "$s" ;;
  esac
}

# The one command a user needs when they come back weeks later to add a device.
read_url_hint() {
  printf 'grep -Eo "https?://[^ ]*token=[^ ]*" %s | tail -1' "$STDOUT_LOG"
}

# A login shell's PATH is typically full of repeats (~/.zshrc prepending the
# same homebrew bin that /etc/paths already has). Baked into a unit verbatim
# that is just noise, so collapse duplicates keeping first occurrence.
dedupe_path() {
  local IFS=: out="" p seen=":"
  for p in $1; do
    [ -n "$p" ] || continue
    case "$seen" in *":$p:"*) continue ;; esac
    seen="$seen$p:"
    out="${out:+$out:}$p"
  done
  printf '%s' "$out"
}

# ── arguments ───────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --trusted-host) [ $# -ge 2 ] || die "--trusted-host needs a value"; TRUSTED_HOSTS+=("$2"); shift 2 ;;
    --patch)        [ $# -ge 2 ] || die "--patch needs a value";        PATCHES+=("$2");       shift 2 ;;
    --port)         [ $# -ge 2 ] || die "--port needs a value";         PORT="$2";             shift 2 ;;
    --profile)      [ $# -ge 2 ] || die "--profile needs a value";      PROFILE="$2";          shift 2 ;;
    --plugin)       [ $# -ge 2 ] || die "--plugin needs a value";       PLUGINS+=("$2");       shift 2 ;;
    --no-default-plugins) SKIP_DEFAULT_PLUGINS=1; shift ;;
    --dsh)          [ $# -ge 2 ] || die "--dsh needs a value";          DSH_BIN="$2";          shift 2 ;;
    --dsh-home)     [ $# -ge 2 ] || die "--dsh-home needs a value";     DSH_HOME_DIR="$2";     shift 2 ;;
    --workdir)      [ $# -ge 2 ] || die "--workdir needs a value";      WORKDIR="$2";          shift 2 ;;
    --path)         [ $# -ge 2 ] || die "--path needs a value";         SERVICE_PATH="$2";     shift 2 ;;
    --label)        [ $# -ge 2 ] || die "--label needs a value";        LABEL="$2";            shift 2 ;;
    --service)      [ $# -ge 2 ] || die "--service needs a value";      SERVICE_NAME="$2";     shift 2 ;;
    --print-only)   PRINT_ONLY=1; shift ;;
    --uninstall)    UNINSTALL=1;  shift ;;
    -h|--help)      usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

case "$(uname -s)" in
  Darwin) PLATFORM=launchd ;;
  Linux)  PLATFORM=systemd ;;
  *) die "unsupported platform: $(uname -s). This script handles macOS and Linux; see README." ;;
esac

SERVICE_PATH="$(dedupe_path "$SERVICE_PATH")"
[ -n "$SERVICE_PATH" ] || die "--path resolved to an empty PATH"

LAUNCHD_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SYSTEMD_UNIT="$HOME/.config/systemd/user/$SERVICE_NAME.service"

# ── uninstall ───────────────────────────────────────────────────────────────
if [ "$UNINSTALL" = 1 ]; then
  step "Removing the happy-dsh service"
  if [ "$PLATFORM" = launchd ]; then
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || launchctl unload "$LAUNCHD_PLIST" 2>/dev/null || true
    if [ -f "$LAUNCHD_PLIST" ]; then rm -f "$LAUNCHD_PLIST"; note "removed $LAUNCHD_PLIST"; fi
  else
    systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
    if [ -f "$SYSTEMD_UNIT" ]; then rm -f "$SYSTEMD_UNIT"; note "removed $SYSTEMD_UNIT"; fi
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  note "left in place: $DSH_HOME_DIR (delete it to remove credentials and history)"
  exit 0
fi

if [ "${#TRUSTED_HOSTS[@]}" -eq 0 ]; then
  die "--trusted-host is required (the authority your browser will use). Try --help."
fi

# ── resolve the executable ──────────────────────────────────────────────────
# A .js entry is run through node, so a repo checkout
# (`--dsh ~/happy-dsh/apps/cli/lib/bin.js`) needs no global install.
resolve_dsh() {
  local p="$1"
  case "$p" in
    */*) [ -x "$p" ] || [ -f "$p" ] || die "not found or not executable: $p" ;;
    *)   p="$(command -v "$p" 2>/dev/null)" || die "not found on PATH: $1" ;;
  esac
  printf '%s' "$p"
}

if [ -z "$DSH_BIN" ]; then
  DSH_BIN="$(command -v dsh 2>/dev/null || true)"
  if [ -z "$DSH_BIN" ]; then
    die "no 'dsh' on PATH. Install it globally, or point at a checkout:
         --dsh /path/to/happy-dsh/apps/cli/lib/bin.js"
  fi
fi
DSH_BIN="$(resolve_dsh "$DSH_BIN")"

DSH_ARGV=()
case "$DSH_BIN" in
  *.js|*.mjs|*.cjs)
    NODE_BIN="$(command -v node 2>/dev/null || true)"
    [ -n "$NODE_BIN" ] || die "need node on PATH to run $DSH_BIN"
    DSH_ARGV=("$NODE_BIN" "$DSH_BIN")
    ;;
  *) DSH_ARGV=("$DSH_BIN") ;;
esac

# How to *invoke* dsh, before the boot arguments are appended below. `plugin`
# is its own launcher subcommand (`dsh plugin --profile <name> <pnpm args…>`),
# so it needs this prefix rather than the boot command line — appending it to
# DSH_ARGV after the profile and the app flags produces `… plugin …` handed to
# the booted app, which rejects it.
DSH_CMD=("${DSH_ARGV[@]}")

# ── assemble the argument list ──────────────────────────────────────────────
#
# ORDER IS LOAD-BEARING. Three separate rules constrain it, and getting any of
# them wrong produces a service that starts and immediately dies with
# "error: unknown option".
#
#  1. `--patch` is a LAUNCHER flag, not a `dsh web` flag — it lives in
#     apps/cli/src/args.ts beside `--profile`. The launcher stops parsing at
#     the first token it does not recognise and hands the rest to the app:
#
#         "The launcher's flags come first and end at the first token it does
#          not know; everything from there on belongs to the booted app."
#
#     So the moment `--no-open` appears, `--patch` is no longer the launcher's
#     to consume. Launcher flags must come BEFORE any app flag.
#
#  2. `--trusted-host` is variadic (`<authority...>`) and swallows every
#     following token that does not begin with a dash. Keep it LAST among the
#     app flags so it has nothing left to swallow.
#
#  3. The profile name comes first, because args.ts rewrites a leading
#     non-dash token into `--profile <name>`.
#
# Net shape:  dsh <profile> <launcher flags…> <app flags…>
DSH_ARGV+=("$PROFILE")
for p in "${PATCHES[@]+"${PATCHES[@]}"}"; do
  [ -e "$p" ] || die "patch file does not exist: $p"
  DSH_ARGV+=(--patch "$p")
done
DSH_ARGV+=(--no-open)
[ -n "$PORT" ] && DSH_ARGV+=(--port "$PORT")
DSH_ARGV+=(--trusted-host "${TRUSTED_HOSTS[@]}")

# ── the log files must exist 0600 before the supervisor opens them ──────────
STDOUT_LOG="$DSH_HOME_DIR/serve.stdout"
STDERR_LOG="$DSH_HOME_DIR/serve.stderr"
mkdir -p "$DSH_HOME_DIR"
chmod 700 "$DSH_HOME_DIR"
for f in "$STDOUT_LOG" "$STDERR_LOG"; do
  [ -e "$f" ] || : > "$f"
  chmod 600 "$f"
done

# Remember where the log ends before starting anything.
#
# The log is append-only, so it accumulates the URL line from every previous
# boot. A readiness check that just greps the file can therefore match a STALE
# line and announce "Ready" before the new process has bound its port — which
# is exactly what happened while testing this: the script printed a URL, the
# very next command got connection-refused, and the service came up seconds
# later. Only text written after this offset counts as evidence of this boot.
LOG_OFFSET="$(wc -c < "$STDOUT_LOG" | tr -d ' ')"

# ── render ──────────────────────────────────────────────────────────────────
render_launchd() {
  local args_xml="" a
  for a in "${DSH_ARGV[@]}"; do
    args_xml="$args_xml    <string>$(xml_escape "$a")</string>
"
  done
  # ── The heredoc below is UNQUOTED on purpose: it interpolates. ─────────────
  # Which means a backtick or a `$` in the template BODY is live — backticks
  # run as command substitution, `$name` expands. Keep the prose in there free
  # of both. This is not hypothetical: an earlier version of this file had a
  # comment reading "a deliberate `kill` no longer…" and generating the unit
  # executed `kill`, printing "usage: kill" during every install. On a machine
  # where the prose happened to name something real, it would have run that.
  # Prefer plain wording over backticks in the unit templates.
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by deploy/serve/install.sh — edit the script or the flags, not this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>

  <key>ProgramArguments</key>
  <array>
${args_xml}  </array>

  <key>WorkingDirectory</key>
  <string>$(xml_escape "$WORKDIR")</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$SERVICE_PATH")</string>
    <key>DSH_HOME</key>
    <string>$(xml_escape "$DSH_HOME_DIR")</string>

    <!-- Service identity, so a process can tell that it is running inside the
         supervised service. restart.sh reads these to decide whether an
         in-place restart needs a detached handoff.

         The marker alone is NOT proof of ancestry: a detached handoff inherits
         it while running outside the job. restart.sh passes an explicit
         --detached flag to its helper instead of re-deriving membership, and
         OpenClaw solves the same problem with a process-ancestry walk. -->
    <key>HAPPY_DSH_SERVICE</key>
    <string>1</string>
    <key>HAPPY_DSH_LAUNCHD_LABEL</key>
    <string>$(xml_escape "$LABEL")</string>
  </dict>

  <!-- RunAtLoad: start at login. NOTE: a LaunchAgent is a per-user, per-session
       job. It does not run before you log in, and it ends when the session
       ends. Starting a process as you *before login* requires a LaunchDaemon,
       which runs as root — the wrong shape for an agent that must act as you
       with your credentials. Log in once and it stays up. -->
  <key>RunAtLoad</key>
  <true/>

  <!-- KeepAlive true, not {SuccessfulExit: false}: ANY exit comes back.

       DSH's clean exit is what SIGTERM produces, but it is also the simplest
       idiom for "restart me" — a plugin that needs a restart can simply let
       the process exit and let the supervisor bring it back. Making every exit
       recoverable is what makes that work.

       The cost: a deliberate SIGTERM no longer leaves the service down. To
       actually stop it, unload the job:
           launchctl bootout gui/$UID/$(xml_escape "$LABEL")
       ...or use restart.sh --park, which also disables it for the next login.

       This mirrors systemd's Restart=always, which likewise ignores an
       explicit "systemctl stop" only because systemd special-cases it. -->
  <key>KeepAlive</key>
  <true/>

  <!-- launchd's restart rate limit, in seconds.

       NOTE: launchd throttles, it does not give up. Measured: a job exiting 1
       immediately was still being respawned after 60s. systemd's
       StartLimitBurst does stop; launchd has no equivalent. So on macOS a
       permanently broken config retries ~6x/minute forever. The fix is the
       exit-code contract DSH does not implement yet — see the plist in
       launchd/ for the full note. -->
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <!-- How long launchd waits after SIGTERM before SIGKILL.

       DSH documents its own guarantee: apps/cli/src/process-shutdown.ts,
       PROCESS_SHUTDOWN_TIMEOUT_MS = 5000, after which it forces exit. 15s is
       that contract plus margin, and deliberately the same number as the
       systemd unit's TimeoutStopSec so both platforms behave alike.
       (launchd's own default is 20s.) -->
  <key>ExitTimeOut</key>
  <integer>$EXIT_TIMEOUT</integer>

  <!-- Applied when launchd CREATES StandardOutPath / StandardErrorPath.
       63 decimal is 0o077, so those files are born 0600 instead of 0644.
       This is what makes the log containment real even if the files were not
       pre-created below — and it is why the plist can stay world-readable
       while the log holding the launch token does not. -->
  <key>Umask</key>
  <integer>63</integer>

  <!-- A server holding a WebSocket open should not be treated as background
       work, or launchd may throttle its timers. -->
  <key>ProcessType</key>
  <string>Interactive</string>

  <!-- Nothing here needs a terminal; an inherited tty would make interactive
       prompts and /dev/tty probes misbehave under a supervisor. -->
  <key>StandardInPath</key>
  <string>/dev/null</string>

  <key>StandardOutPath</key>
  <string>$(xml_escape "$STDOUT_LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$STDERR_LOG")</string>
</dict>
</plist>
PLIST
}

render_systemd() {
  local exec_line="" a
  for a in "${DSH_ARGV[@]}"; do
    exec_line="$exec_line $(sd_quote "$a")"
  done
  exec_line="${exec_line# }"
  # Unquoted heredoc — see the warning above render_launchd's. No backticks or
  # bare `$` in the template body.
  cat <<UNIT
# Generated by deploy/serve/install.sh — edit the script or the flags, not this file.
[Unit]
Description=happy-dsh Web UI
Documentation=https://github.com/fkysly/happy-dsh
After=network-online.target
Wants=network-online.target

# Give up after 5 starts in 60s rather than looping forever. This is the
# backstop for the missing "my config is broken, do not restart me" exit code.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=$exec_line
WorkingDirectory=$WORKDIR

Environment="PATH=$SERVICE_PATH"
Environment="DSH_HOME=$DSH_HOME_DIR"

# Service identity, so a process can tell that it is running inside the
# supervised service. restart.sh reads these to decide whether an in-place
# restart needs to escape the unit's cgroup first.
#
# The marker alone is NOT proof of ancestry: a detached helper inherits it
# while running outside the unit. restart.sh passes an explicit --detached
# flag instead of re-deriving membership.
Environment="HAPPY_DSH_SERVICE=1"
Environment="HAPPY_DSH_SYSTEMD_UNIT=$SERVICE_NAME"

# always, not on-failure: ANY exit comes back. DSH's clean exit is what SIGTERM
# produces, but it is also the simplest idiom for "restart me" — a plugin that
# needs a restart can simply let the process exit and let systemd bring it
# back. That is what makes plugin-driven restarts work.
#
# An explicit "systemctl --user stop" still stops: systemd special-cases it and
# does not apply Restart= to it. So stopping means the service manager, not
# killing the process. Mirrors launchd's KeepAlive=true in the plist.
Restart=always
RestartSec=5

# DSH guarantees it exits within 5s of SIGTERM — apps/cli/src/process-shutdown.ts
# PROCESS_SHUTDOWN_TIMEOUT_MS = 5000, with a forced exit after. $STOP_TIMEOUT s is that
# contract plus room for systemd's own bookkeeping; a second SIGTERM escalates
# immediately, so there is no need to send KILL early.
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=$STOP_TIMEOUT

# Nothing here needs a terminal; an inherited tty would make interactive
# prompts and /dev/tty probes misbehave under a supervisor.
StandardInput=null

# UMask is applied when systemd CREATES the log files below: 0077 means they
# are born 0600 instead of 0644. This is the systemd counterpart of the
# plist's Umask key, and it is what makes the containment real even if the
# files were not pre-created above.
UMask=0077

# stdout/stderr to a 0600 file, NOT the journal: the boot line carries the
# launch token, which mints a session cookie for any trusted authority and is
# valid until the process exits. Both files are pre-created 0600 above.
StandardOutput=append:$STDOUT_LOG
StandardError=append:$STDERR_LOG

[Install]
WantedBy=default.target
UNIT
}

render() {
  if [ "$PLATFORM" = launchd ]; then render_launchd; else render_systemd; fi
}

if [ "$PRINT_ONLY" = 1 ]; then
  render
  exit 0
fi

# ── install the profile's plugins ───────────────────────────────────────────
#
# This runs BEFORE the unit is loaded, and that order is the point: `dsh plugin`
# initializes a profile that does not exist yet from its shipped template
# (apps/cli/src/plugin.ts), so a fresh `web` profile arrives with base + web-app
# *and* these plugins in one boot instead of needing a second restart.
#
# Nothing here touches the profile's other dependencies — `add` appends — and
# `--uninstall` deliberately leaves them, along with the rest of DSH_HOME.
#
# A failure warns rather than dying: the service is the deliverable, and a
# machine that cannot reach the registry should still get one. Printing the
# retry command is what keeps the default from going missing quietly.
PLUGIN_SPECS=()
if [ "$SKIP_DEFAULT_PLUGINS" != 1 ]; then
  PLUGIN_SPECS+=("${DEFAULT_PLUGINS[@]}")
fi
if [ "${#PLUGINS[@]}" -gt 0 ]; then
  PLUGIN_SPECS+=("${PLUGINS[@]}")
fi

if [ "${#PLUGIN_SPECS[@]}" -gt 0 ]; then
  step "Installing ${#PLUGIN_SPECS[@]} plugin(s) into profile '$PROFILE'"
  # DSH_HOME is passed explicitly: the unit gets it from its own environment
  # (below), but this child is still the caller's, and `--dsh-home` has to mean
  # the same thing to both or the service boots a profile nobody installed into.
  if DSH_HOME="$DSH_HOME_DIR" "${DSH_CMD[@]}" plugin --profile "$PROFILE" add "${PLUGIN_SPECS[@]}"; then
    note "installed: ${PLUGIN_SPECS[*]}"
    note "they mount on the service's first start"
  else
    printf '\n  ⚠ the plugin install failed; the service is installed without them.\n'
    printf '    Retry once the registry is reachable:\n\n'
    printf '        %s plugin --profile %s add %s\n\n' "${DSH_CMD[*]}" "$PROFILE" "${PLUGIN_SPECS[*]}"
  fi
fi

# ── install ─────────────────────────────────────────────────────────────────
if [ "$PLATFORM" = launchd ]; then
  step "Installing launchd agent $LABEL"
  mkdir -p "$HOME/Library/LaunchAgents"
  render > "$LAUNCHD_PLIST"
  note "wrote $LAUNCHD_PLIST"
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true

  # ── Do not bootstrap immediately after bootout ────────────────────────────
  # After a bootout the label stays registered until launchd has finished
  # stopping the old process, and that stop is bounded by ExitTimeOut. A
  # bootstrap issued during that window fails with EIO ("Bootstrap failed: 5")
  # and can leave the agent deregistered. OpenClaw hit exactly this and filed
  # it as #110137; its wait is ExitTimeOut + 15s and its bootstrap retries 15
  # times. Both numbers are copied here, with the same 1s poll.
  wait_s=$((EXIT_TIMEOUT + 15))
  while [ "$wait_s" -gt 0 ]; do
    launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || break
    wait_s=$((wait_s - 1))
    sleep 1
  done

  launchctl enable "gui/$UID/$LABEL" 2>/dev/null || true
  tries=15
  while :; do
    if launchctl bootstrap "gui/$UID" "$LAUNCHD_PLIST" 2>/dev/null; then
      break
    fi
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then
      die "could not load $LAUNCHD_PLIST after 15 attempts.
         The label may still be registered from a previous install. Check with:
             launchctl print gui/$UID/$LABEL"
    fi
    sleep 1
  done
  note "loaded, and enabled for future logins"
else
  step "Installing systemd user unit $SERVICE_NAME"
  mkdir -p "$(dirname "$SYSTEMD_UNIT")"
  render > "$SYSTEMD_UNIT"
  note "wrote $SYSTEMD_UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"
  note "enabled and started"
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != "yes" ]; then
    printf '\n  ⚠ Not started automatically at boot yet.\n'
    printf '    A systemd *user* service starts at login, not at boot. To start it\n'
    printf '    at boot without a login session, enable lingering:\n\n'
    printf '        sudo loginctl enable-linger %s\n\n' "$USER"
  fi
fi

# ── prove the log file is not world-readable ────────────────────────────────
mode="$(stat -f '%Lp' "$STDOUT_LOG" 2>/dev/null || stat -c '%a' "$STDOUT_LOG" 2>/dev/null || echo '?')"
if [ "$mode" != "600" ]; then
  printf '\n  ⚠ %s is mode %s, expected 600 — your launch token may be readable by others.\n' "$STDOUT_LOG" "$mode"
  printf '    Fix: chmod 600 %s\n' "$STDOUT_LOG"
fi

# ── surface the URL now, so the first run needs no manual log-digging ───────
step "Waiting for the Web UI to come up"
url=""
for _ in $(seq 1 40); do
  # Only the bytes written since LOG_OFFSET — see the note where it is set.
  url="$(tail -c +$((LOG_OFFSET + 1)) "$STDOUT_LOG" 2>/dev/null \
         | grep -Eo 'https?://[^[:space:]]*token=[^[:space:]]*' | tail -1 || true)"
  [ -n "$url" ] && break
  sleep 0.5
done

if [ -n "$url" ]; then
  printf '\n  Ready. Open this once to mint a session cookie:\n\n'
  printf '      %s\n\n' "$url"
  printf '  Treat this URL as a password — it stays valid until the process restarts.\n'
  printf '  The cookie it mints lasts 30 days and survives restarts.\n'
else
  printf '\n  No URL in %s yet. Check %s.\n\n' "$STDOUT_LOG" "$STDERR_LOG"
fi

printf '  Re-read it later with:\n\n      %s\n\n' "$(read_url_hint)"

#!/usr/bin/env bash
#
# happy-dsh — restart (or park) the supervised service, including from a shell
# that is itself running inside it.
#
#   ./restart.sh                 # restart
#   ./restart.sh --park          # stop, and keep it stopped
#   ./restart.sh --dry-run       # print what it would do
#
# ── Why this is not just `systemctl --user restart` ─────────────────────────
# The interesting case is an agent running INSIDE the service, restarting its
# own host. A naive restart kills the caller mid-command: `launchctl kickstart
# -k` destroys the job's process group, and on systemd the unit's KillMode
# reaches the child shell too. The command then either half-runs or reports a
# failure it did not actually have.
#
# So when this script detects that it is running inside the service, it does
# not act directly. It re-launches itself detached, waits for the original
# caller to disappear, and only then touches the service manager. That is the
# shape OpenClaw uses for the same problem; it is not a workaround for a bug in
# either service manager, it is just what restarting your own supervisor costs.
#
# ── The other restart path, which needs none of this ────────────────────────
# The unit sets Restart=always / KeepAlive=true, so ANY exit is followed by a
# relaunch. A plugin that needs a restart can therefore simply let the process
# exit. That is the simplest idiom, and it needs no helper at all — this script
# exists for the deliberate case where something wants to stay alive long
# enough to observe the restart.

set -uo pipefail

LABEL="${HAPPY_DSH_LAUNCHD_LABEL:-ai.happy-dsh.web}"
SERVICE_NAME="${HAPPY_DSH_SYSTEMD_UNIT:-happy-dsh-web}"
PARK=0
DRY_RUN=0
DETACHED_WAIT_PID=""
INSIDE_TIMEOUT=30

die() { printf 'restart.sh: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --label)   [ $# -ge 2 ] || die "--label needs a value";   LABEL="$2";        shift 2 ;;
    --service) [ $# -ge 2 ] || die "--service needs a value"; SERVICE_NAME="$2"; shift 2 ;;
    --park)    PARK=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    # Internal: this invocation IS the detached helper. Wait for the named pid
    # to exit before acting, so the caller can finish its own teardown first.
    # An explicit flag rather than re-running detection is deliberate: the
    # helper inherits HAPPY_DSH_SERVICE from the job it was spawned by, so
    # re-deriving membership would make it detach itself again, forever.
    --detached) [ $# -ge 2 ] || die "--detached needs a pid"; DETACHED_WAIT_PID="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

case "$(uname -s)" in
  Darwin) PLATFORM=launchd ;;
  Linux)  PLATFORM=systemd ;;
  *) die "unsupported platform: $(uname -s)" ;;
esac

GUI_DOMAIN="gui/$UID"
TARGET="$GUI_DOMAIN/$LABEL"

# macOS has no setsid(1), so the detach uses node — which is present by
# definition, since node is what runs DSH. Still, do not trust PATH alone: a
# shell with a minimal environment is exactly the situation this script is
# meant to survive, so fall back to the usual install locations.
find_node() {
  local n
  n="$(command -v node 2>/dev/null)" && { printf '%s' "$n"; return 0; }
  for n in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$n" ]; then printf '%s' "$n"; return 0; fi
  done
  return 1
}

# ── are we running inside the service? ──────────────────────────────────────
service_main_pid() {
  if [ "$PLATFORM" = launchd ]; then
    launchctl print "$TARGET" 2>/dev/null | awk '/[[:space:]]pid = /{print $3; exit}'
  else
    systemctl --user show "$SERVICE_NAME" -p MainPID --value 2>/dev/null | awk '$1 != 0 {print $1}'
  fi
}

# Walk our own parent chain looking for the service's main process.
# If the walk fails we answer "yes, inside" — a broken `ps` must not disable
# the guard, because acting directly is the outcome that breaks the caller.
self_is_descendant_of() {
  local want="$1" pid=$$ hops=0
  [ -n "$want" ] || return 1
  while [ "$hops" -lt 40 ]; do
    if [ "$pid" = "$want" ]; then return 0; fi
    if [ "$pid" -le 1 ] 2>/dev/null; then return 1; fi
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ -n "$pid" ] || return 0   # walk failed — fail safe toward "inside"
    hops=$((hops + 1))
  done
  return 1
}

is_inside_service() {
  [ "${HAPPY_DSH_SERVICE:-}" = "1" ] || return 1
  self_is_descendant_of "$(service_main_pid)"
}

# ── the two things we can do ────────────────────────────────────────────────
do_restart() {
  if [ "$PLATFORM" = launchd ]; then
    # `enable` first: a previous park may have disabled the job, and an
    # explicit restart is operator intent that should undo that.
    launchctl enable "$TARGET" 2>/dev/null || true
    launchctl kickstart -k "$TARGET"
  else
    systemctl --user restart "$SERVICE_NAME"
  fi
}

do_park() {
  # "Stop, and stay stopped" is two operations, and both are needed:
  #   disable — stops it being started again by the next login / boot
  #   bootout — unloads the running job now
  # Without the disable, a park survives only until the next login.
  if [ "$PLATFORM" = launchd ]; then
    launchctl disable "$TARGET" 2>/dev/null || true
    launchctl bootout "$TARGET" 2>/dev/null || true
  else
    systemctl --user disable --now "$SERVICE_NAME"
  fi
}

if [ "$DRY_RUN" = 1 ]; then
  step "dry run"
  note "platform    $PLATFORM"
  note "target      $([ "$PLATFORM" = launchd ] && echo "$TARGET" || echo "$SERVICE_NAME")"
  note "action      $([ "$PARK" = 1 ] && echo park || echo restart)"
  note "inside      $(is_inside_service && echo yes || echo no)"
  note "detached    $([ -n "$DETACHED_WAIT_PID" ] && echo "yes, waiting on pid $DETACHED_WAIT_PID" || echo no)"
  exit 0
fi

# ── detached helper: wait for the caller, then act ──────────────────────────
if [ -n "$DETACHED_WAIT_PID" ]; then
  waited=0
  while [ "$waited" -lt $((INSIDE_TIMEOUT * 5)) ]; do
    kill -0 "$DETACHED_WAIT_PID" 2>/dev/null || break
    sleep 0.2
    waited=$((waited + 1))
  done
  # Act even if the wait timed out: the caller may be wedged, and refusing here
  # would leave the service unattended with no way to restart it.
  if [ "$PARK" = 1 ]; then do_park; else do_restart; fi
  exit $?
fi

# ── detach if we are inside ────────────────────────────────────────────────
if is_inside_service; then
  step "Running inside the service — handing off to a detached helper"
  note "the caller (pid $$) must exit before the service can be restarted"

  # Built as an array rather than with ${PARK:+--park}: PARK is 0 or 1, and
  # "0" is a non-empty string, so `:+` would add --park on every run.
  HANDOFF_ARGS=(--detached "$$")
  [ "$PARK" = 1 ] && HANDOFF_ARGS=(--park "${HANDOFF_ARGS[@]}")

  if [ "$PLATFORM" = systemd ]; then
    # A detached child still inherits our cgroup, and the unit's KillMode
    # reaches every process in it — so detaching is not enough on systemd.
    # A transient unit is the mechanism that actually escapes the cgroup.
    command -v systemd-run >/dev/null 2>&1 || die \
      "restarting from inside the service on Linux needs systemd-run, which is
         not on PATH. Run this from a shell outside the service instead."
    systemd-run --user --quiet --collect \
      --unit="happy-dsh-restart-$$" \
      "$0" --service "$SERVICE_NAME" "${HANDOFF_ARGS[@]}"
  else
    NODE_BIN="$(find_node)" || die \
      "restarting from inside the service needs a node binary, and none was
         found on PATH or in the usual locations. Run this from a shell outside
         the service instead — there, no detach is required."
    "$NODE_BIN" -e '
      const { spawn } = require("node:child_process");
      const child = spawn(process.argv[1], process.argv.slice(2), {
        detached: true, stdio: "ignore",
      });
      // Node reports spawn failure asynchronously; confirm it started before
      // the caller exits, or a failed handoff strands the service.
      child.once("spawn", () => { child.unref(); process.exit(0) });
      child.once("error", (e) => { console.error(String(e)); process.exit(1) });
    ' "$0" --label "$LABEL" "${HANDOFF_ARGS[@]}" || die "handoff failed to start"

    note "handoff started"
  fi

  note "the service will restart once this process exits"
  exit 0
fi

# ── outside the service: just do it ────────────────────────────────────────
if [ "$PARK" = 1 ]; then
  step "Parking the happy-dsh service (it will stay stopped)"
  do_park
  note "parked. Restart it with: $0"
else
  step "Restarting the happy-dsh service"
  do_restart
  note "restarted"

  # Deliberately NOT printing the new URL: it carries the launch token, and
  # this script's output regularly ends up in an agent transcript, a terminal
  # scrollback, or a log. Point at it instead.
  LOG="${DSH_HOME:-$HOME/.dsh}/serve.stdout"
  note "read the new URL with:"
  note "    grep -Eo 'https?://[^ ]*token=[^ ]*' $LOG | tail -1"
fi

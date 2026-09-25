#!/usr/bin/env bash
#
# Prove the preinstalled plugin pair installs and boots the service.
#
# `install.sh` puts two third-party plugins into the profile before the service
# is loaded, and DSH's boot is all-or-nothing: one plugin that fails to load
# takes the whole process down with it. So a pin that cannot start is worse than
# a pin that is merely stale, and `happy-dsh:preinstall check` — which only
# compares versions — cannot see the difference.
#
# This is the difference, measured the way a new deployment would meet it: a
# scratch DSH_HOME, a profile that does not exist yet (so `add` initializes it
# from its shipped template, exactly as on a fresh machine), the pinned specs
# installed from the registry, and then a real boot on a scratch port. The
# service is up when it prints its token URL; it is killed after that.
#
#   bash deploy/release/preinstall-smoke.sh
#   bash deploy/release/preinstall-smoke.sh --registry https://registry.npmmirror.com --keep
#
# Exit codes: 0 the pair installs and boots, 1 it does not, 2 usage.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE=web
PORT=3899
REGISTRY=""
KEEP=0
BOOT_TIMEOUT_SECONDS=120
# A name this smoke declares as reachable, to check the market's origin fence
# agrees with the host's. It is never resolved: the fence compares the Host
# header, and curl sends whatever we tell it to.
FENCE_NAME=preinstall-smoke.internal

step() { printf '\n==> %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
die() { printf '\n  ✗ %s\n\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --registry) [ $# -ge 2 ] || { echo "--registry needs a value" >&2; exit 2; }; REGISTRY="$2"; shift 2 ;;
    --port)     [ $# -ge 2 ] || { echo "--port needs a value" >&2; exit 2; };     PORT="$2";     shift 2 ;;
    --profile)  [ $# -ge 2 ] || { echo "--profile needs a value" >&2; exit 2; };  PROFILE="$2";  shift 2 ;;
    --keep)     KEEP=1; shift ;;
    -h|--help)  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$ROOT"

DSH_BIN="apps/cli/lib/bin.js"
# The pins are read by the script that owns them, not by a second parser here:
# a smoke that disagreed with the installer about what is pinned would prove
# nothing about what a deployment gets.
SPECS="$(pnpm --silent run happy-dsh:preinstall specs)"
[ -n "$SPECS" ] || die "could not read the pins from deploy/serve/install.sh"

DSH_HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/happy-dsh-preinstall-smoke.XXXXXX")"
LOG="$DSH_HOME_DIR/boot.log"
BOOT_PID=""

cleanup() {
  [ -n "$BOOT_PID" ] && kill "$BOOT_PID" 2>/dev/null
  [ -n "$BOOT_PID" ] && wait "$BOOT_PID" 2>/dev/null
  if [ "$KEEP" = 1 ]; then
    printf '\n  kept: %s\n\n' "$DSH_HOME_DIR"
  else
    rm -rf "$DSH_HOME_DIR"
  fi
}
trap cleanup EXIT

printf '\n  preinstall smoke: %s\n  scratch DSH_HOME: %s\n  port: %s\n' "$SPECS" "$DSH_HOME_DIR" "$PORT"

step "Installing the pinned pair into a profile that does not exist yet"
# `${a[@]}` on an empty array is an "unbound variable" under `set -u` in the
# bash 3.2 macOS ships, so the expansion is guarded rather than the array.
REGISTRY_ARG=()
[ -n "$REGISTRY" ] && REGISTRY_ARG=(--registry "$REGISTRY")
install_output="$(DSH_HOME="$DSH_HOME_DIR" node "$DSH_BIN" plugin --profile "$PROFILE" \
  add $SPECS ${REGISTRY_ARG[@]+"${REGISTRY_ARG[@]}"} 2>&1)"
install_status=$?
if [ $install_status -ne 0 ]; then
  printf '%s\n' "$install_output" | tail -20
  # Which registry answered is the first thing to know here: a pin that exists
  # upstream can be missing from a mirror for a while, and that reads as "the
  # pins do not install" when it is really "this mirror has not seen it yet".
  if [ -n "$REGISTRY" ]; then
    die "the pins do not install (exit $install_status) from $REGISTRY. A release must not ship these specs."
  fi
  die "the pins do not install (exit $install_status) from the default registry. A release must not ship these specs.
    A pin this new may simply not have reached a mirror yet:
        bash deploy/release/preinstall-smoke.sh --registry https://registry.npmjs.org"
fi
printf '%s\n' "$install_output" | tail -3

step "Composing the profile"
config="$(DSH_HOME="$DSH_HOME_DIR" node "$DSH_BIN" --profile "$PROFILE" --dump-config 2>&1)" \
  || { printf '%s\n' "$config" | tail -20; die "the profile does not compose with these plugins"; }
for spec in $SPECS; do
  name="${spec%@*}"
  printf '%s\n' "$config" | grep -q "name: $name" \
    || { printf '%s\n' "$config" | tail -20; die "$name is pinned but does not appear in the composed tree"; }
  note "composed: $name"
done

step "Booting the service on port $PORT, reached by name"
# `--trusted-host` is what a deployment does to be reachable by a name, and it is
# the shape the market's own fence has to agree with. Variadic, so it comes last.
DSH_HOME="$DSH_HOME_DIR" node "$DSH_BIN" web --no-open --port "$PORT" \
  --trusted-host "$FENCE_NAME" > "$LOG" 2>&1 &
BOOT_PID=$!

# The token URL is the readiness signal: it is printed once the app is serving,
# and a boot that dies prints its failure to the same log instead.
waited=0
ready=0
while [ "$waited" -lt "$BOOT_TIMEOUT_SECONDS" ]; do
  if ! kill -0 "$BOOT_PID" 2>/dev/null; then
    printf '\n'; tail -25 "$LOG"
    die "the service exited while starting; the pinned plugins do not boot"
  fi
  if grep -q 'token=' "$LOG" 2>/dev/null; then ready=1; break; fi
  sleep 1
  waited=$((waited + 1))
done

if [ "$ready" != 1 ]; then
  printf '\n'; tail -25 "$LOG"
  die "the service did not report itself ready within ${BOOT_TIMEOUT_SECONDS}s"
fi
SERVER_TOKEN="$(grep -Eo 'token=[^ ]+' "$LOG" | tail -1)"
SERVER_TOKEN="${SERVER_TOKEN#token=}"

code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null || echo 000)"
if [ "$code" != "401" ] && [ "$code" != "200" ] && [ "$code" != "302" ]; then
  printf '\n'; tail -25 "$LOG"
  die "the service reported ready but answers HTTP $code on 127.0.0.1:$PORT"
fi

step "The market's origin fence agrees with the host's"
# The market registers its routes as `exact` matches on the bare webServer, so
# they never pass through the host's own /api fence and the market re-implements
# the rule. That re-implementation has been wrong twice for the shape this
# smoke exists to cover: 1.65.1 refused every named host, and 1.65.3 read the
# host's declared authorities once at mount, before the connection service it
# reads them from exists -- so a deployment reached by a name was read-only
# while loopback worked (dsh-market#729). Both are invisible to a version check.
JAR="$DSH_HOME_DIR/fence.cookies"
curl -sS -c "$JAR" -H "Host: $FENCE_NAME" -o /dev/null "http://127.0.0.1:$PORT/?token=$SERVER_TOKEN" || true

fence_post() {
  curl -sS -b "$JAR" -o "$DSH_HOME_DIR/fence.body" -w '%{http_code}' \
    -X POST "http://127.0.0.1:$PORT/dsh-market/channel" \
    -H "Host: $1" -H "Origin: https://$1" -H 'Content-Type: application/json' -d '{}'
}

declared_status="$(fence_post "$FENCE_NAME")"
if [ "$declared_status" = "403" ] && grep -q 'untrusted origin' "$DSH_HOME_DIR/fence.body"; then
  printf '\n'; tail -25 "$LOG"
  printf '\n  ✗ the market refused a mutation from %s, an authority this deployment declares.\n' "$FENCE_NAME"
  printf '    Its fence never sees the host'"'"'s /api rule (exact routes win over the prefix),\n'
  printf '    so it has to read the declared authorities itself -- and it is not doing so here.\n'
  printf '    On dsh-market 1.65.3 that is #729: the read happens at mount, before the\n'
  printf '    `connection` service exists, and the empty fallback then narrows the fence\n'
  printf '    to loopback for the life of the process. Fix it upstream, or pin a version\n'
  printf '    that reads the authorities per request.\n\n'
  exit 1
fi
note "declared authority accepted (HTTP $declared_status)"

undeclared_status="$(fence_post preinstall-smoke.undeclared)"
if [ "$undeclared_status" != "403" ]; then
  printf '\n'; tail -25 "$LOG"
  die "the market accepted a mutation from an undeclared host (HTTP $undeclared_status)"
fi
note "undeclared host refused (HTTP 403)"

printf '\n  ✓ installed and booted: %s\n' "$SPECS"
printf '    the service answered HTTP %s after %ss\n' "$code" "$waited"
printf '    and its market agrees with %s about who may mutate\n\n' "$FENCE_NAME"

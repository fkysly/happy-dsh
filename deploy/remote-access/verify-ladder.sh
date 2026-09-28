#!/usr/bin/env bash
#
# happy-dsh — walk the trust fence against a running deployment.
#
#   ./verify-ladder.sh [base-url] [authority]
#   ./verify-ladder.sh http://127.0.0.1:3080 dsh.dev
#
# Exits non-zero if any step is not what it should be.
#
# Why this is worth running against a *service* rather than a hand-started
# process: the unit bakes in flags (--patch, --trusted-host, --port) that a
# manual `dsh web` does not have, and it is those flags that decide the
# authority set.
#
# The fence decides reachability and establishes no identity. Nothing here
# proves who is calling, because nothing can: a request that passes the fence
# is served, and that is the whole policy.

set -uo pipefail

BASE="${1:-http://127.0.0.1:3080}"
AUTH="${2:-dsh.dev}"

# The WebSocket step needs node. Do not trust PATH: a minimal environment is
# normal when running this over ssh or from a service.
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
  done
fi
[ -n "$NODE_BIN" ] || echo "warning: no node found; the WebSocket step will be skipped" >&2

PORT_HOST="${BASE#*://}"
fails=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then printf '  ok    %-46s %s\n' "$1" "$3"
  else printf '  FAIL  %-46s got %s, want %s\n' "$1" "$3" "$2"; fails=$((fails+1)); fi
}

# /api/probe is the fenced surface; the index (`/`) passes the same fence now
# and renders instead of refusing, so an untrusted Host is what a fence failure
# looks like on either.
api() { curl -s -o /dev/null -w '%{http_code}' -X POST "$@" \
          -H 'Content-Type: application/json' -d '{}' "$BASE/api/probe"; }

echo "authority   $AUTH"
echo "base        $BASE"

echo
echo "1. Host fence (DNS rebinding)"
check "untrusted Host -> 403" 403 "$(api -H 'Host: evil.example' -H 'Origin: http://evil.example')"
check "cross-site marker -> 403" 403 \
  "$(api -H "Host: $AUTH" -H "Origin: http://$AUTH" -H 'Sec-Fetch-Site: cross-site')"
check "mismatched Origin -> 403" 403 \
  "$(api -H "Host: $AUTH" -H 'Origin: http://evil.example')"

echo
echo "2. A fence-passing request is admitted with no session"
# Admission, not success: /api/probe is not a real RPC method, so an admitted
# request answers 404 ("no such method"). Asserting 200 here would be wrong —
# what matters is that the request got past the fence.
ADMITTED="$(api -H "Host: $AUTH" -H "Origin: http://$AUTH")"
case "$ADMITTED" in
  401|403) printf '  FAIL  %-46s got %s (refused)\n' "trusted Host -> admitted" "$ADMITTED"; fails=$((fails+1)) ;;
  *)       printf '  ok    %-46s %s (admitted)\n' "trusted Host -> admitted" "$ADMITTED" ;;
esac

echo
echo "3. The index passes the same fence"
# The index carries boot-injected data, so it is fenced like /api: a trusted
# authority renders it, an undeclared one is refused before it is read.
check "trusted Host GET / -> 200" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $AUTH" "$BASE/")"
check "untrusted Host GET / -> 403" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "$BASE/")"

echo
echo "4. WebSocket upgrade (/api/remote.mux)"
if [ -z "$NODE_BIN" ]; then
  echo "  skipped — no node available"
else
ws() { "$NODE_BIN" -e '
const http=require("node:http");
const host=process.argv[1];
const req=http.request({host:"127.0.0.1",port:Number(process.argv[2]||3080),path:"/api/remote.mux",
  headers:{Host:host,Connection:"Upgrade",Upgrade:"websocket",
    "Sec-WebSocket-Version":"13","Sec-WebSocket-Key":"dGhlIHNhbXBsZSBub25jZQ==",
    Origin:"http://"+host}});
req.on("upgrade",()=>{console.log(101);req.destroy()});
req.on("response",r=>{console.log(r.statusCode);req.destroy()});
req.on("error",e=>{console.log("ERR:"+e.code);});
req.end();' "$1" "${PORT_HOST##*:}"; }
check "no trust -> 403" 403 "$(ws evil.example)"
check "trusted -> 101" 101 "$(ws "$AUTH")"
fi

echo
if [ "$fails" -eq 0 ]; then echo "all checks passed"; else echo "$fails check(s) FAILED"; fi
exit "$fails"

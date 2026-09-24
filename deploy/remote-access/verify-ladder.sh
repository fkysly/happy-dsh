#!/usr/bin/env bash
#
# happy-dsh — walk the authentication ladder against a running deployment.
#
#   ./verify-ladder.sh [base-url] [authority]
#   ./verify-ladder.sh http://127.0.0.1:3080 dsh.dev
#
# Reads the launch token from the service log, so it only works on the host.
# Never prints the token. Exits non-zero if any step is not what it should be.
#
# Why this is worth running against a *service* rather than a hand-started
# process: the unit bakes in flags (--patch, --trusted-host, --port) that a
# manual `dsh web` does not have, and it is those flags that decide the
# authority set.

set -uo pipefail

BASE="${1:-http://127.0.0.1:3080}"
AUTH="${2:-dsh.dev}"
LOG="${DSH_HOME:-$HOME/.dsh}/serve.stdout"

TOKEN="$(grep -Eo 'token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2)"
[ -n "$TOKEN" ] || { echo "no token found in $LOG" >&2; exit 1; }

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

# /api/probe is the fenced surface. `GET /` is NOT: it is answered by the index
# handler, which returns 401 for a missing session regardless of Host. Testing
# the fence against `/` reports 401 and looks like a broken fence.
api() { curl -s -o /dev/null -w '%{http_code}' -X POST "$@" \
          -H 'Content-Type: application/json' -d '{}' "$BASE/api/probe"; }

echo "authority   $AUTH"
echo "base        $BASE"

echo
echo "1. Host fence (DNS rebinding)"
check "untrusted Host -> 403" 403 "$(api -H 'Host: evil.example' -H 'Origin: http://evil.example')"
check "trusted Host, no cookie -> 401" 401 "$(api -H "Host: $AUTH" -H "Origin: http://$AUTH")"
check "cross-site marker -> 403" 403 \
  "$(api -H "Host: $AUTH" -H "Origin: http://$AUTH" -H 'Sec-Fetch-Site: cross-site')"
check "mismatched Origin -> 403" 403 \
  "$(api -H "Host: $AUTH" -H 'Origin: http://evil.example')"

echo
echo "2. Token exchange"
# curl lowercases header names; sed matches case-insensitively on the value.
HDR="$(curl -s -D- -o /dev/null -H "Host: $AUTH" "$BASE/?token=$TOKEN")"
check "GET /?token= -> 303" 303 "$(printf '%s' "$HDR" | head -1 | awk '{print $2}')"
COOKIE="$(printf '%s' "$HDR" | grep -i '^set-cookie:' | head -1 | cut -d' ' -f2- | cut -d';' -f1)"
if [ -n "$COOKIE" ]; then echo "  ok    set-cookie present"
else echo "  FAIL  no set-cookie"; fails=$((fails+1)); fi

echo
echo "3. Cookie is bound to its authority"
# Admission, not success: /api/probe is not a real RPC method, so an admitted
# request answers 404 ("no such method"). Asserting 200 here would be wrong —
# what matters is that the request got past the fence and the session check.
ADMITTED="$(api -H "Host: $AUTH" -H "Origin: http://$AUTH" -H "Cookie: $COOKIE")"
case "$ADMITTED" in
  401|403) printf '  FAIL  %-46s got %s (refused)\n' "cookie + right authority -> admitted" "$ADMITTED"; fails=$((fails+1)) ;;
  *)       printf '  ok    %-46s %s (admitted)\n' "cookie + right authority -> admitted" "$ADMITTED" ;;
esac
check "cookie + OTHER authority -> 403" 403 \
  "$(api -H 'Host: other.example' -H 'Origin: http://other.example' -H "Cookie: $COOKIE")"

echo
echo "4. WebSocket upgrade (/api/remote.mux)"
if [ -z "$NODE_BIN" ]; then
  echo "  skipped — no node available"
else
ws() { "$NODE_BIN" -e '
const http=require("node:http");
const [host,cookie]=process.argv.slice(1);
const req=http.request({host:"127.0.0.1",port:Number(process.argv[3]||3080),path:"/api/remote.mux",
  headers:{Host:host,Connection:"Upgrade",Upgrade:"websocket",
    "Sec-WebSocket-Version":"13","Sec-WebSocket-Key":"dGhlIHNhbXBsZSBub25jZQ==",
    Origin:"http://"+host,...(cookie?{Cookie:cookie}:{})}});
req.on("upgrade",()=>{console.log(101);req.destroy()});
req.on("response",r=>{console.log(r.statusCode);req.destroy()});
req.on("error",e=>{console.log("ERR:"+e.code);});
req.end();' "$1" "$2" "${PORT_HOST##*:}"; }
check "no trust -> 403" 403 "$(ws evil.example '')"
check "trusted, no cookie -> 401" 401 "$(ws "$AUTH" '')"
check "trusted + cookie -> 101" 101 "$(ws "$AUTH" "$COOKIE")"
fi

echo
if [ "$fails" -eq 0 ]; then echo "all checks passed"; else echo "$fails check(s) FAILED"; fi
exit "$fails"

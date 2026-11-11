#!/usr/bin/env bash
# ziwei-mcp Phase 2 HTTP test suite. Run: bash tests/http-tests.sh
# Requires: ziwei-mcp.service running (systemctl --user start ziwei-mcp), curl, node.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WS="${WS:-$(cd "$HERE/../.." && pwd)}"
TOK="$(cat "$HERE/.token")"
BASE="${BASE:-http://127.0.0.1:9878}"
pass=0; fail=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# v0.4.0: the daemon enforces a per-token 30 req/min budget (burst 10). This
# suite is a burst client by nature — retry once after the advertised
# Retry-After window instead of failing a test that is rate-limited, not
# broken. Set ZIWEI_MCP_RATE_PER_MIN=0 on the daemon to disable entirely.
post() {
  local out code body
  out=$(curl -s -w '\n%{http_code}' -X POST "$1" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' --data-binary @- <<EOF
$2
EOF
)
  code="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [ "$code" = 429 ]; then
    sleep 3
    out=$(curl -s -w '\n%{http_code}' -X POST "$1" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' --data-binary @- <<EOF
$2
EOF
)
    code="${out##*$'\n'}"; body="${out%$'\n'*}"
  fi
  printf '%s' "$body"
}

# 1. health without auth
[ "$(code "$BASE/health")" = 200 ] && ok "health 200 no-auth" || bad "health"
curl -s "$BASE/health" | grep -q '"status":"ok"' && curl -s "$BASE/health" | grep -q '"version":"0.4.0"' && ok "health body" || bad "health body"

# 2. auth rejection
[ "$(code -X POST "$BASE/mcp" -H 'Content-Type: application/json' -d '{}')" = 401 ] && ok "no-token 401" || bad "no-token 401"
[ "$(code -X POST "$BASE/mcp" -H 'Authorization: Bearer wrong' -H 'Content-Type: application/json' -d '{}')" = 401 ] && ok "wrong-token 401" || bad "wrong-token 401"

# 3. protocol over HTTP
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}')
echo "$R" | grep -q '"serverInfo"' && echo "$R" | grep -q '"version":"0.4.0"' && ok "initialize" || bad "initialize"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
echo "$R" | grep -q ziwei_chart && echo "$R" | grep -q ziwei_sihua_layers && ok "tools/list" || bad "tools/list"
[ "$(code -X POST "$BASE/mcp" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]')" = 200 ] && ok "batch 200" || bad "batch"

# 4. gold standard chart
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}')
echo "$R" | grep -q '1986-12-09' && echo "$R" | grep -q '23:29:34' && ok "gold chart via HTTP" || bad "gold chart via HTTP"

# 5. gold layers
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liunian"]}}}')
echo "$R" | grep -q '天同' && echo "$R" | grep -q '官禄' && ok "gold layers via HTTP" || bad "gold layers via HTTP"

# 6. ?token= query param accepted
[ "$(code -X POST "$BASE/mcp?token=$TOK" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}')" = 200 ] && ok "query-param token" || bad "query-param token"

# ─── SSE (Streamable HTTP GET /mcp) ───────────────────────────────────────────
TMPD=$(mktemp -d)
cleanup() { kill $(jobs -p) 2>/dev/null; rm -rf "$TMPD"; }
trap cleanup EXIT

# 7. GET /mcp with Accept: text/event-stream + token → 200 event-stream, stays
#    open ≥ 20 s, keep-alive comment observed within the interval.
T0=$(date +%s)
curl -s -D "$TMPD/hdr" -o "$TMPD/body" --max-time 25 \
  -H "Authorization: Bearer $TOK" -H 'Accept: text/event-stream' "$BASE/mcp" &
wait $!; SSE_RC=$?
T1=$(date +%s); DUR=$((T1-T0))
grep -q '^HTTP/[0-9.]* 200' "$TMPD/hdr" && grep -qi 'content-type: text/event-stream' "$TMPD/hdr" \
  && [ "$SSE_RC" -eq 28 ] && [ "$DUR" -ge 20 ] && grep -q '^: ping' "$TMPD/body" \
  && ok "SSE 200 event-stream, open ${DUR}s (rc $SSE_RC), keep-alive seen" || bad "SSE stream (rc=$SSE_RC dur=$DUR)"

# 8. GET /mcp without/wrong token → 401, no stream opened
[ "$(code -X GET "$BASE/mcp" -H 'Accept: text/event-stream')" = 401 ] && ok "SSE no-token 401" || bad "SSE no-token 401"
[ "$(code -X GET "$BASE/mcp" -H "Authorization: Bearer wrong" -H 'Accept: text/event-stream')" = 401 ] && ok "SSE wrong-token 401" || bad "SSE wrong-token 401"

# 9. GET /mcp with token but NO Accept: text/event-stream → 405 (documented)
[ "$(code -X GET "$BASE/mcp" -H "Authorization: Bearer $TOK")" = 405 ] && ok "SSE no-Accept 405" || bad "SSE no-Accept 405"

# 10. Coexistence: POST gold chart while an SSE stream is open → correct JSON
#     result on the POST connection, stream unaffected.
curl -s -D "$TMPD/hdr2" -o "$TMPD/stream2" --max-time 60 \
  -H "Authorization: Bearer $TOK" -H 'Accept: text/event-stream' "$BASE/mcp" &
BG=$!
sleep 1
kill -0 "$BG" 2>/dev/null && ok "SSE stream background alive" || bad "SSE stream died early"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}')
echo "$R" | grep -q '1986-12-09' && echo "$R" | grep -q '23:29:34' && ok "gold chart during open SSE stream" || bad "gold chart during SSE"
kill -0 "$BG" 2>/dev/null && ok "stream unaffected by POST" || bad "stream killed by POST"

# 11. Session id header present + DELETE closes the stream cleanly
SID=$(grep -i '^mcp-session-id:' "$TMPD/hdr2" | head -1 | tr -d '\r' | awk '{print $2}')
[ -n "$SID" ] && ok "SSE Mcp-Session-Id header present" || bad "no Mcp-Session-Id header"
[ "$(code -X DELETE "$BASE/mcp" -H "Authorization: Bearer $TOK" -H "Mcp-Session-Id: $SID")" = 200 ] && ok "DELETE session 200" || bad "DELETE session 200"
kill "$BG" 2>/dev/null; wait "$BG" 2>/dev/null
[ "$(code -X DELETE "$BASE/mcp" -H "Authorization: Bearer $TOK" -H 'Mcp-Session-Id: bogus')" = 404 ] && ok "DELETE unknown session 404" || bad "DELETE unknown session 404"

# 12. POST with Mcp-Session-Id header still returns plain JSON (backward compat)
R=$(curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -H "Mcp-Session-Id: whatever" -D "$TMPD/hdr3" -d '{"jsonrpc":"2.0","id":1,"method":"ping"}')
grep -qi 'content-type: application/json' "$TMPD/hdr3" && echo "$R" | grep -q '"result"' && ok "POST with session header = JSON mode" || bad "POST session-header JSON mode"

# 13. tools/list over HTTP shows ALL tools (2026-11-03 all-tools batch)
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
ALL_OK=1
for t in ziwei_chart ziwei_sihua_layers ziwei_from_city ziwei_solar_lunar ziwei_selftest ziwei_compatibility ziwei_batch_stats ziwei_school_compare ziwei_render; do
  echo "$R" | grep -q "$t" || ALL_OK=0
done
[ "$ALL_OK" = 1 ] && ok "tools/list exposes all 9 tools over HTTP" || bad "tools/list missing new tools over HTTP"

# 14. new tools over HTTP: selftest + from_city + solar_lunar + render + school_compare + batch_stats
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_selftest","arguments":{}}}')
echo "$R" | grep -q 'pass.*true' && echo "$R" | grep -q 'effectiveDate' && ok "ziwei_selftest pass=true via HTTP" || bad "ziwei_selftest via HTTP"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_from_city","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","city":"Hong Kong"}}}')
echo "$R" | grep -q '1986-12-09' && echo "$R" | grep -q '23:29:34' && ok "ziwei_from_city(Hong Kong) gold chart via HTTP" || bad "ziwei_from_city via HTTP"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_solar_lunar","arguments":{"lunar":{"year":1986,"month":11,"day":8}}}}')
echo "$R" | grep -q 'lunar-to-solar' && echo "$R" | grep -q '丁亥' && echo "$R" | grep -q 'day.*9' && ok "ziwei_solar_lunar round-trip via HTTP" || bad "ziwei_solar_lunar via HTTP"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_render","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}')
echo "$R" | grep -q 'svg xmlns' && echo "$R" | grep -q '命宫' && ok "ziwei_render emits svg via HTTP" || bad "ziwei_render via HTTP"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_school_compare","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}')
echo "$R" | grep -q 'current-day' && echo "$R" | grep -q 'diffFromDefault' && ok "ziwei_school_compare via HTTP" || bad "ziwei_school_compare via HTTP"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_batch_stats","arguments":{"question":"wuxingJu-distribution","gender":"male","yearFrom":1950,"yearTo":1950,"maxCharts":500}}}')
echo "$R" | grep -q '木三局\|水二局\|火六局\|土五局\|金四局' && echo "$R" | grep -q 'chartsComputed' && ok "ziwei_batch_stats via HTTP" || bad "ziwei_batch_stats via HTTP"


# 15. bugfix/feature assertions over HTTP (2026-11-04)
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"month":1}}}')
echo "$R" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(JSON.parse(JSON.parse(s).result.content[0].text).layers.liuyue.ganzhiYear?JSON.stringify(JSON.parse(JSON.parse(s).result.content[0].text)):s);const ly=JSON.parse(s).result.content[0].text;const o=JSON.parse(ly).layers.liuyue;if(o.stem!=="戊"||o.ganzhiYear!=="乙巳")process.exit(1)})' && ok "HTTP bug1: 2026-01 liuyue stem 戊 + ganzhiYear 乙巳" || bad "HTTP bug1 2026-01"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}')
echo "$R" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const m=JSON.parse(JSON.parse(s).result.content[0].text).meta.rawInput;if(m.day!==8||m.hour!==23)process.exit(1)})' && ok "HTTP bug2: meta.rawInput echoes day 12 / hour 23" || bad "HTTP bug2 rawInput"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"yearWindow":"丙午","gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liunian"]}}}')
echo "$R" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const l=JSON.parse(JSON.parse(s).result.content[0].text).layers.liunian;if(l.stem!=="丙"||l.ganzhiYear!=="丙午"||l.transforms["禄"].star!=="天同")process.exit(1)})' && ok "HTTP featureA: yearWindow 丙午 liunian" || bad "HTTP featureA yearWindow"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_compatibility","arguments":{"a":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2},"b":{"year":1994,"month":6,"day":15,"hour":8,"minute":0,"gender":"female"}}}}')
echo "$R" | grep -q 'daXianCheck' && echo "$R" | grep -q 'sameDaxianPalaceBranch' && ok "HTTP featureB: daXianCheck block" || bad "HTTP featureB daXianCheck"

# ─── 2026-11-05 deep-fix HTTP assertions ────────────────────────────────────
# 16. batch_stats must NOT block the event loop: fire a full-range default
#     batch (async spawn now), then GET /health 3× spaced 1 s — each response
#     must arrive < 5 s while the batch is still running.
( post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_batch_stats","arguments":{"question":"wuxingJu-distribution","gender":"male"}}}' > "$TMPD/batch.out" 2>/dev/null ) &
BATCH_PID=$!
sleep 0.5
HEALTH_OK=1
for i in 1 2 3; do
  T0=$(date +%s%N)
  HC=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")
  T1=$(date +%s%N)
  MS=$(( (T1 - T0) / 1000000 ))
  echo "  health during batch: $HC in ${MS}ms"
  [ "$HC" = 200 ] && [ "$MS" -lt 5000 ] || HEALTH_OK=0
  [ "$i" -lt 3 ] && sleep 1
done
wait "$BATCH_PID" 2>/dev/null
grep -q 'chartsComputed' "$TMPD/batch.out" && [ "$HEALTH_OK" = 1 ] \
  && ok "batch_stats non-blocking: 3× health <5s during full-range batch" || bad "health blocked during batch_stats"
kill "$BATCH_PID" 2>/dev/null

# 17. deep-fix behaviors over HTTP: mirror true pair, lunarMonth:1 = 庚,
#     year+yearWindow reject, solar bound, ignoredKeys echo.
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_compatibility","arguments":{"a":{"year":1970,"month":5,"day":15,"hour":10,"minute":0,"gender":"male"},"b":{"year":1988,"month":11,"day":15,"hour":10,"minute":0,"gender":"female"}}}}')
echo "$R" | grep -q 'tianZuoZhiHe.*true' && ok "HTTP deepfix1: tianZuoZhiHe true for cross-subset pair" || bad "HTTP deepfix1 mirror"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":12,"minute":0},"layers":["liuyue"],"lunarMonth":1}}}')
echo "$R" | grep -q '庚' && echo "$R" | grep -q '丙午' && ok "HTTP deepfix2: lunarMonth:1 2026 -> 庚/丙午" || bad "HTTP deepfix2 lunarMonth"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"yearWindow":"丙午","gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":12,"minute":0},"layers":["liunian"]}}}')
echo "$R" | grep -q 'not both' && ok "HTTP deepfix5b: year+yearWindow -> isError" || bad "HTTP deepfix5b"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_solar_lunar","arguments":{"solar":{"year":1850,"month":6,"day":15}}}}')
echo "$R" | grep -q 'isError.*true\|1900' && ok "HTTP deepfix5c: solar 1850 bounded" || bad "HTTP deepfix5c"
R=$(post "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":12,"minute":0,"gender":"male","evil":"x"}}}')
echo "$R" | grep -q 'ignoredKeys' && ok "HTTP deepfix5a: ignoredKeys echoed for unknown arg" || bad "HTTP deepfix5a"

echo "──── HTTP: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

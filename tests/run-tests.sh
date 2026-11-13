#!/usr/bin/env bash
# ziwei-mcp Phase 1 test suite (A-D). Run: bash tests/run-tests.sh
# Requires: vendored engine at ../../vendor/ziwei-doushu (see README Install).
# WS defaults to the repo root inferred from this script's location; override
# with WS=... if the checkout layout differs.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WS="${WS:-$(cd "$HERE/../.." && pwd)}"
TSX="$WS/vendor/ziwei-doushu/node_modules/.bin/tsx"
SRV="$WS/services/ziwei-mcp/index.ts"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ziwei-mcp-tests.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP"
pass=0; fail=0
ok()   { echo "PASS: $1"; pass=$((pass+1)); }
bad()  { echo "FAIL: $1"; fail=$((fail+1)); }

# ── A: protocol ──────────────────────────────────────────────────────────────
A="$TMP/a.jsonl"
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}' \
 '{"jsonrpc":"2.0","id":4,"method":"bogus/method"}' \
 | "$TSX" "$SRV" > "$TMP/a.out" 2> "$TMP/a.err"
if node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const init=L.find(x=>x.id===1).result;
if(init.serverInfo.name!=="ziwei-mcp"||init.serverInfo.version!=="0.3.2")process.exit(1);
if(init.protocolVersion!=="2025-06-18")process.exit(1);
if(!init.capabilities.tools)process.exit(1);
const tl=L.find(x=>x.id===2).result.tools;
if(tl.length<2||!tl.every(t=>t.inputSchema&&t.name))process.exit(1);
if(!tl.some(t=>t.name==="ziwei_chart")||!tl.some(t=>t.name==="ziwei_sihua_layers"))process.exit(1);
// 2026-11-03 all-tools batch: tools/list must expose every registered tool
const EXPECTED=["ziwei_chart","ziwei_patterns","ziwei_sihua_layers","ziwei_from_city","ziwei_solar_lunar","ziwei_selftest","ziwei_compatibility","ziwei_batch_stats","ziwei_school_compare","ziwei_render"];
if(tl.length!==EXPECTED.length||!EXPECTED.every(n=>tl.some(t=>t.name===n)))process.exit(1);
const call=L.find(x=>x.id===3).result;
if(!call.content||call.content[0].type!=="text"||!JSON.parse(call.content[0].text).chart)process.exit(1);
const err=L.find(x=>x.id===4);
if(!err.error||err.error.code!==-32601)process.exit(1);
' "$TMP/a.out"; then ok "A protocol: handshake+tools/list+tools/call+(-32601)"; else bad "A protocol"; fi
# stdout pure JSON lines
if node -e 'require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").forEach(l=>JSON.parse(l))' "$TMP/a.out"; then
  ok "A stdout purity: every line valid JSON (stderr separate)"; else bad "A stdout purity"; fi

# ── B: reference chart (gold standard) ───────────────────────────────────────
B="$TMP/b.jsonl"
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male"}}}' \
 | "$TSX" "$SRV" > "$TMP/b.out" 2>/dev/null
if node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const r=JSON.parse(L.find(x=>x.id===2).result.content[0].text);
const c=r.chart, BR=["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
const mg=c.palaces.find(p=>p.isMingGong);
const eq=(a,b,m)=>{if(a!==b){console.error(m+": "+JSON.stringify(a)+" != "+JSON.stringify(b));process.exit(1)}};
eq(r.meta.effectiveDate,"1986-12-09","effectiveDate");
const fp=c.lunarInfo.fourPillars.join("/");
eq(fp,"丙寅/庚子/丁亥/庚子","fourPillars");
eq(BR[mg.branch],"子","命宮 branch");
const jm=mg.stars.find(s=>s.type==="major");
if(!jm||jm.name!=="天同"){console.error("命宮 main star not 天同");process.exit(1)}
eq(jm.brightnessRaw,"旺","天同 brightness");
eq(c.wuxingJuName,"土五局","wuxingJu");
eq(c.mingZhu,"贪狼","命主");
eq(c.shenZhu,"天梁","身主");
const pal=n=>c.palaces.find(p=>p.name===n);
const has=(pn,st,sh)=>{const p=pal(pn);return p&&p.stars.some(s=>s.name===st&&s.siHua===sh)};
if(!has("命宫","天同","禄")){console.error("天同祿 not in 命宮");process.exit(1)}
if(!has("官禄","天机","权")){console.error("天機權 not in 官禄");process.exit(1)}
if(!has("夫妻","文昌","科")){console.error("文昌科 not in 夫妻");process.exit(1)}
if(!has("子女","廉贞","忌")){console.error("廉貞忌 not in 子女");process.exit(1)}
// no-longitude call: chart must be identical except birthInfo.longitude
const r2=JSON.parse(L.find(x=>x.id===3).result.content[0].text);
const c2=r2.chart;
for(const k of Object.keys(c)) if(k!=="birthInfo"){ if(JSON.stringify(c[k])!==JSON.stringify(c2[k])){console.error("chart differs in "+k);process.exit(1)} }
for(const k of Object.keys(c.birthInfo)) if(k!=="longitude"&&c.birthInfo[k]!==c2.birthInfo[k]){console.error("birthInfo differs");process.exit(1)}
if(c.birthInfo.longitude!==114.2||c2.birthInfo.longitude!==undefined){console.error("longitude field mismatch");process.exit(1)}
if(r2.meta.longitude!==null||r2.meta.trueSolarTime!==null){console.error("no-longitude meta not inert");process.exit(1)}
' "$TMP/b.out"; then ok "B reference chart: gold standard + no-longitude inertness"; else bad "B reference chart"; fi

# ── C: layers ────────────────────────────────────────────────────────────────
C="$TMP/c.jsonl"
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["daxian","liunian","liuyue"],"lunarMonth":8}}}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2025,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"lunarMonth":8}}}' \
 | "$TSX" "$SRV" > "$TMP/c.out" 2>/dev/null
if node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const r=JSON.parse(L.find(x=>x.id===2).result.content[0].text);
const ln=r.layers.liunian.t;
const t=r.layers.liunian.transforms;
const eq=(o,k,star,pal,m)=>{if(o[k].star!==star||o[k].palace!==pal){console.error(m+" got "+JSON.stringify(o[k]));process.exit(1)}};
if(r.layers.liunian.stem!=="丙"){console.error("2026 stem not 丙");process.exit(1)}
eq(t,"禄","天同","命宫","liunian 祿");
eq(t,"权","天机","官禄","liunian 權");
eq(t,"科","文昌","夫妻","liunian 科");
eq(t,"忌","廉贞","子女","liunian 忌");
const ly=r.layers.liuyue;
if(ly.lunarMonth!==8){console.error("lunarMonth not 8");process.exit(1)}
// 2026 = 丙午 year; 五虎遁 丙辛起庚寅 → lunar month 8 stem = 丁 (NOT 乙;
// the spec assertion "2026 month 8 stem = 乙" is off by one year — 乙 is the stem of 2025 乙巳.)
if(ly.stem!=="丁"){console.error("2026 lunar m8 stem not 丁: "+ly.stem);process.exit(1)}
const ji=ly.transforms["忌"];
if(ji.star!=="巨门"||ji.palace!=="福德"){console.error("2026 m8 丁忌→巨门福德 got "+JSON.stringify(ji));process.exit(1)}
// year-2025 equivalent of the spec assertion: 乙巳 year, lunar m8 stem = 乙,
// 乙 table: 太陰化忌 lands in 命宮 for the anchor birth.
const L3=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const r3=JSON.parse(L3.find(x=>x.id===3).result.content[0].text);
const ly3=r3.layers.liuyue;
if(ly3.stem!=="乙"){console.error("2025 lunar m8 stem not 乙: "+ly3.stem);process.exit(1)}
const ji3=ly3.transforms["忌"];
if(ji3.star!=="太阴"||ji3.palace!=="命宫"){console.error("2025 m8 太陰忌→命宫 got "+JSON.stringify(ji3));process.exit(1)}
if(!Array.isArray(r.layers.daxian.ageRanges)||typeof r.layers.daxian.currentLayerIndex!=="number"){console.error("daxian structure");process.exit(1)}
' "$TMP/c.out"; then ok "C layers: liunian 2026 exact + liuyue stems (2026丁/2025乙 太陰忌→命宫) + daxian structure"; else bad "C layers"; fi

# ── D: robustness ────────────────────────────────────────────────────────────
D="$TMP/d.jsonl"
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":13,"day":1,"hour":12,"minute":0,"gender":"male"}}}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":2025,"month":2,"day":30,"hour":12,"minute":0,"gender":"female"}}}' \
 '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"other"}}}' \
 'garbage{' \
 '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":1986,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45},"layers":["nope"]}}}' \
 '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male"}}}' \
 | "$TSX" "$SRV" > "$TMP/d.out" 2>/dev/null
echo "exit=$?"
if node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const g=id=>L.find(x=>x.id===id);
const isErr=id=>{const x=g(id);return x.result&&x.result.isError===true&&x.result.content[0].text.length>10};
if(!isErr(2)){console.error("month 13 not isError");process.exit(1)}
if(!isErr(3)){console.error("2/30 not isError");process.exit(1)}
if(!isErr(4)){console.error("bad gender not isError");process.exit(1)}
if(!g(5).result||g(5).result.isError!==true){console.error("bad layer not isError");process.exit(1)}
if(g(6).result.isError){console.error("valid call after errors failed");process.exit(1)}
if(!g(6).result.content[0].text.includes("chart")){console.error("recovery call bad");process.exit(1)}
const parseErr=L.find(x=>x.error&&x.error.code===-32700);
if(!parseErr){console.error("no parse error for garbage line");process.exit(1)}
' "$TMP/d.out"; then ok "D robustness: isError + survives + keeps serving"; else bad "D robustness"; fi

# ── E: new tools (2026-11-03 all-tools batch) ────────────────────────────────
E="$TMP/e.jsonl"
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ziwei_from_city","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","city":"Hong Kong"}}}' \
 '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ziwei_from_city","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","city":"香港"}}}' \
 '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"ziwei_from_city","arguments":{"year":1990,"month":1,"day":1,"hour":12,"minute":0,"gender":"male","city":"Atlantis"}}}' \
 '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"ziwei_solar_lunar","arguments":{"solar":{"year":1986,"month":12,"day":9}}}}' \
 '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ziwei_solar_lunar","arguments":{"lunar":{"year":1986,"month":11,"day":8}}}}' \
 '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"ziwei_selftest","arguments":{}}}' \
 '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"ziwei_compatibility","arguments":{"a":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2},"b":{"year":1994,"month":6,"day":15,"hour":8,"minute":0,"gender":"female"}}}}' \
 '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"ziwei_batch_stats","arguments":{"question":"wuxingJu-distribution","gender":"male","yearFrom":1950,"yearTo":1951,"maxCharts":1000}}}' \
 '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuri","liushi"],"flowDate":{"year":2026,"month":11,"day":3},"flowHour":10}}}' \
 '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"ziwei_school_compare","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}' \
 '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"ziwei_render","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}' \
 | "$TSX" "$SRV" > "$TMP/e.out" 2>/dev/null
if node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const g=id=>L.find(x=>x.id===id);
const R=id=>JSON.parse(g(id).result.content[0].text);
const eq=(cond,msg)=>{if(!cond){console.error(msg);process.exit(1)}};
// tools/list shows all 9
// (each new tool called once with valid input → content, no isError)
for(const id of [3,6,7,8,9,10,11,12,13]){eq(!g(id).result.isError,"tool call id "+id+" isError: "+g(id).result.content[0].text.slice(0,120))}
// ziwei_from_city("Hong Kong") and ("香港") == ziwei_chart lon 114.2 (chart-identical)
const c1=R(2).chart, c2=R(3).chart, c3=R(4).chart;
for(const k of Object.keys(c1)) if(k!=="birthInfo"){eq(JSON.stringify(c1[k])===JSON.stringify(c2[k]),"from_city(HK) differs in "+k)}
for(const k of Object.keys(c1)) if(k!=="birthInfo"){eq(JSON.stringify(c1[k])===JSON.stringify(c3[k]),"from_city(香港) differs in "+k)}
eq(R(3).meta.cityResolved.longitude===114.2,"HK city longitude");
// unknown city → isError with suggestions
const bad=g(5).result;
eq(bad.isError===true&&/unknown city/.test(bad.content[0].text)&&/Examples/.test(bad.content[0].text),"unknown-city not isError-with-suggestions");
// solar_lunar round-trip: 1986-12-09 <-> lunar 1986-11-08
const s2l=R(6), l2s=R(7);
eq(s2l.lunar.year===1986&&s2l.lunar.month===11&&s2l.lunar.day===8&&!s2l.lunar.isLeap,"solar->lunar 1986-12-09");
eq(l2s.solar.year===1986&&l2s.solar.month===12&&l2s.solar.day===9,"lunar->solar round-trip");
eq(s2l.fourPillars.slice(0,3).join("/")==="丙寅/庚子/丁亥","solar_lunar y/m/d pillars");
// selftest passes all checks
const st=R(8);eq(st.pass===true&&st.checks.length>=8,"selftest not pass");
// compatibility: structured per-dimension findings present
eq(R(9).sides&&R(9).findings&&R(9).findings.flyingSihua&&R(9).findings.mirrorTest&&R(9).scoreCriteriaReference,"compat structure");
// batch_stats: sane counts sum to chartsComputed
const bs=R(10);const sum=Object.values(bs.distribution).reduce((a,b)=>a+b,0);
eq(bs.chartsComputed>=100&&sum===bs.chartsComputed&&Object.keys(bs.distribution).length===5,"batch-stats sane: n="+bs.chartsComputed+" sum="+sum);
// liuri/liushi layers: stems + transforms mapped + caveat present
const ly=R(11).layers;
eq(ly.liuri&&ly.liuri.stem&&ly.liuri.transforms&&Object.keys(ly.liuri.transforms).length===4,"liuri layer");
eq(ly.liushi&&ly.liushi.stem&&ly.liushi.transforms,"liushi layer");
eq(/informational only/.test(ly.liuri.precisionCaveat),"liuri caveat");
// school_compare: default variant zero-diff, current-day differs (gold birth is late-zi)
const sc=R(12).variants;
eq(sc["lateZishi=next-day (default)"].diffFromDefault.length===0,"default variant should be baseline");
eq(sc["lateZishi=current-day (倪师派)"].diffFromDefault.length>0,"current-day must differ for late-zi birth");
eq(sc["lateZishi=current-day (倪师派)"].diffFromDefault.some(d=>d.startsWith("effectiveDate")),"current-day diff must include effectiveDate");
// render: valid svg XML wrapper + 12 palace labels
const svg=R(13).svg;
eq(svg.startsWith("<svg")&&svg.endsWith("</svg>")&&svg.includes("xmlns"),"svg wrapper");
for(const n of ["命宫","迁移","财帛","子女","夫妻","兄弟","福德","田宅","官禄","仆役","疾厄","父母"])eq(svg.includes(n),"svg missing palace label "+n);
eq(svg.includes("命宫 ★"),"svg missing mingGong star marker");
eq(svg.includes("viewBox=\"0 0 600 600\""),"svg grid layout");
' "$TMP/e.out"; then ok "E new tools: city/city-zh/unknown-city, solar_lunar round-trip, selftest, compat, batch-stats, liuri/liushi, school-compare, render"; else bad "E new tools"; fi


# ── F: bug-fix + feature regression (2026-11-04, extended 2026-11-05) ───────
F="$TMP/f.jsonl"
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2025,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"month":1}}}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"month":1}}}' \
 '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2027,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"month":1}}}' \
 '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"month":3}}}' \
 '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"lunarMonth":12}}}' \
 '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}' \
 '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"ziwei_batch_stats","arguments":{"question":"wuxingJu-distribution","gender":"male","yearFrom":1950,"yearTo":1950,"hours":"all"}}}' \
 '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"ziwei_batch_stats","arguments":{"question":"wuxingJu-distribution","gender":"male","yearFrom":1950,"yearTo":1950,"hours":[6]}}}' \
 '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"yearWindow":"丙午","gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liunian"]}}}' \
 '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"yearWindow":"甲丑","gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liunian"]}}}' \
 '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"yearWindow":"乙巳","gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liunian"]}}}' \
 '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"ziwei_compatibility","arguments":{"a":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2},"b":{"year":1994,"month":6,"day":15,"hour":8,"minute":0,"gender":"female"}}}}' \
 '{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"ziwei_render","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2,"layers":["liunian"],"flowYear":2026}}}' \
 '{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"ziwei_selftest","arguments":{}}}' \
 '{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"ziwei_render","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}' \
 '{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2023,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"flowDate":{"year":2023,"month":4,"day":25}}}}' \
 '{"jsonrpc":"2.0","id":18,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2023,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"flowDate":{"year":2023,"month":4,"day":5}}}}' \
 '{"jsonrpc":"2.0","id":19,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2023,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"month":4}}}' \
 '{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"month":1}}}' \
 '{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"yearWindow":"癸卯","gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"month":4}}}' \
 '{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"month":3}}}' \
 '{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["liuyue"],"month":1}}}' \
 | "$TSX" "$SRV" > "$TMP/f.out" 2>/dev/null
if node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const g=id=>L.find(x=>x.id===id);
const R=id=>{if(!g(id).result||g(id).result.isError)throw new Error("id "+id+" isError: "+(g(id).result?g(id).result.content[0].text.slice(0,150):"no result"));return JSON.parse(g(id).result.content[0].text)};
const eq=(cond,msg)=>{if(!cond){console.error(msg);process.exit(1)}};
// BUG 1: liuyue month stem across lichun boundary (engine lunar tables)
let ly=R(2).layers.liuyue;
eq(ly.stem==="丁","2025-01 stem not 丁 (got "+ly.stem+")");
eq(ly.yearStemUsed==="甲","2025-01 yearStemUsed not 甲 (got "+ly.yearStemUsed+")");
eq(ly.ganzhiYear==="甲辰","2025-01 ganzhiYear not 甲辰 (got "+ly.ganzhiYear+")");
ly=R(3).layers.liuyue;
eq(ly.stem==="戊","2026-01 stem not 戊 (got "+ly.stem+")");
eq(ly.yearStemUsed==="乙","2026-01 yearStemUsed not 乙 (got "+ly.yearStemUsed+")");
eq(ly.ganzhiYear==="乙巳","2026-01 ganzhiYear not 乙巳 (got "+ly.ganzhiYear+")");
ly=R(4).layers.liuyue;
eq(ly.stem==="辛","2027-01 stem not 辛 (got "+ly.stem+")");
eq(ly.yearStemUsed==="丙","2027-01 yearStemUsed not 丙 (got "+ly.yearStemUsed+")");
eq(ly.ganzhiYear==="丙午","2027-01 ganzhiYear not 丙午 (got "+ly.ganzhiYear+")");
// post-lichun control: 2026-03 = 丙午 year m1 = 庚寅 (unchanged behavior).
// 2026-11-05 ordinary-straddle defense: 2026-03 spans m1→m2 (first day 正月
// 初七, last day 二月初二) → must be FLAGGED now, stem unchanged 庚.
ly=R(5).layers.liuyue;
eq(ly.stem==="庚","2026-03 control stem not 庚 (got "+ly.stem+")");
eq(ly.yearStemUsed==="丙","2026-03 control yearStemUsed not 丙 (got "+ly.yearStemUsed+")");
eq(ly.ambiguousMonth===true,"2026-03 ordinary straddle not flagged ambiguousMonth");
// month-12 sanity (2026 丙午, 五虎遁 丙辛起庚寅: m12 = 辛)
ly=R(6).layers.liuyue;
eq(ly.stem==="辛","2026 lunar m12 stem not 辛 (got "+ly.stem+")");
// BUG 2: meta.rawInput echoes raw caller args; birthInfo untouched
let c7=R(7);
eq(c7.meta.rawInput&&c7.meta.rawInput.day===8,"rawInput.day not 8");
eq(c7.meta.rawInput.hour===23,"rawInput.hour not 23 (got "+(c7.meta.rawInput&&c7.meta.rawInput.hour)+")");
eq(c7.meta.rawInput.year===1986&&c7.meta.rawInput.month===12&&c7.meta.rawInput.minute===45&&c7.meta.rawInput.gender==="male","rawInput fields wrong");
eq(c7.meta.rawInput.longitude===114.2,"rawInput.longitude not 114.2");
eq(c7.chart.birthInfo.day===9&&c7.chart.birthInfo.hour===0,"birthInfo changed (must stay engine-corrected)");
// BUG 3: hours:"all" = 12x single-hour census
const n8=R(8).chartsComputed, n9=R(9).chartsComputed;
eq(n9===365,"single-hour 1950 count not 365 (got "+n9+")");
eq(n8===365*12,"hours:all 1950 count not 4380 (got "+n8+")");
// FEATURE A: yearWindow ganzhi mode
let ln=R(10).layers.liunian;
eq(ln.stem==="丙","yearWindow 丙午 stem not 丙 (got "+ln.stem+")");
eq(ln.ganzhiYear==="丙午"&&ln.yearStemUsed==="丙","yearWindow echo wrong (got "+ln.ganzhiYear+"/"+ln.yearStemUsed+")");
eq(ln.transforms["禄"].star==="天同"&&ln.transforms["忌"].star==="廉贞","yearWindow 丙午 transforms wrong");
eq(g(11).result&&g(11).result.isError===true,"invalid ganzhi 甲丑 not isError");
ln=R(12).layers.liunian;
eq(ln.stem==="乙"&&ln.ganzhiYear==="乙巳","yearWindow 乙巳 stem not 乙 (got "+ln.stem+")");
// FEATURE B: compatibility daXianCheck
const dx=R(13).daXianCheck;
eq(dx&&dx.a&&dx.b,"daXianCheck block missing");
eq(typeof dx.flags.sameDaxianPalaceBranch==="boolean","sameDaxianPalaceBranch flag missing");
eq(typeof dx.flags.sameDaxianStem==="boolean","sameDaxianStem flag missing");
eq(typeof dx.flags.sameDaxianGanzhi==="boolean","sameDaxianGanzhi flag missing");
eq(dx.flags.sameDaxianGanzhi===(dx.flags.sameDaxianPalaceBranch&&dx.flags.sameDaxianStem),"sameDaxianGanzhi not equal to branch&&stem");
eq(dx.a.ji&&typeof dx.a.ji.intoOtherMingGong==="boolean","a ji-into-other-mingGong flag missing");
eq(dx.b.ji&&typeof dx.b.ji.intoOtherMingGong==="boolean","b ji-into-other-mingGong flag missing");
// FEATURE C: render overlay
const svg=R(14).svg;
eq(svg.includes("流年"),"render liunian overlay missing (no legend/badge)");
eq(svg.includes("stroke-dasharray"),"render overlay dashed style missing");
// SELFTEST extension
eq(R(15).checks.some(c=>c.name==="liuyueStem2023Apr25"&&c.expected==="丙"&&c.ok),"selftest missing leap-straddle check liuyueStem2023Apr25");
eq(R(15).checks.some(c=>c.name==="ordinaryStraddle2026Mar"&&c.ok),"selftest missing ordinary-straddle lock-in check ordinaryStraddle2026Mar");
const st=R(15);
eq(st.pass===true,"selftest not pass");
eq(st.checks.length>=12,"selftest checks <12 (got "+st.checks.length+")");
// BUG 4 (leap-month straddle, 2026-11-04 late evening): flowDate honored by day
let ly17=R(17).layers.liuyue;
eq(ly17.stem==="丙","2023-04-25 flowDate stem not 丙 (got "+ly17.stem+")");
eq(ly17.lunarMonth===3&&ly17.isLeapMonth===false,"2023-04-25 not lunar m3 non-leap (got "+ly17.lunarMonth+"/"+ly17.isLeapMonth+")");
eq(ly17.yearStemUsed==="癸"&&ly17.ganzhiYear==="癸卯","2023-04-25 year stem not 癸卯 (got "+ly17.yearStemUsed+ly17.ganzhiYear+")");
let ly18=R(18).layers.liuyue;
eq(ly18.stem==="乙","2023-04-05 flowDate stem not 乙 (got "+ly18.stem+")");
eq(ly18.lunarMonth===2&&ly18.isLeapMonth===true,"2023-04-05 not leap m2 (got "+ly18.lunarMonth+"/"+ly18.isLeapMonth+")");
// UNIFIED MID-MONTH RULE (2026-11-05): month-only resolves to the lunar month
// containing the 15th; ANY boundary straddle (leap or ordinary) flags
// ambiguousMonth. 2023-04-15 = 闰二月十五 → 乙 (was 丙 via later-segment).
let ly19=R(19).layers.liuyue;
eq(ly19.stem==="乙","2023-04 month-only stem not 乙 (mid-month 闰二月; got "+ly19.stem+")");
eq(ly19.ambiguousMonth===true,"2023-04 month-only missing ambiguousMonth flag");
eq(typeof ly19.note==="string"&&/flowDate/.test(ly19.note),"2023-04 month-only note missing or no flowDate recommendation");
let ly20=R(20).layers.liuyue;
eq(ly20.stem==="戊","2026-01 month-only stem changed (must stay 戊, got "+ly20.stem+")");
eq(ly20.ambiguousMonth===true,"2026-01 not flagged ambiguousMonth (ordinary straddle 11→12)");
let ly21=R(21).layers.liuyue;
eq(ly21.stem==="乙"&&ly21.ambiguousMonth===true,"yearWindow 癸卯 month 4 straddle not flagged 乙 (got "+ly21.stem+"/"+ly21.ambiguousMonth+")");
// DESCRIPTIVE SPAN FIELDS (2026-11-05 reviewer round 3 follow-up): month-only
// gains monthSpan (ordered lunar months the solar month spans) + resolvedAs
// (deterministic resolution string naming the sampled date). ambiguousMonth
// stays as-is for backward compat.
let ly22=R(22).layers.liuyue;
eq(Array.isArray(ly22.monthSpan),"2026-03 monthSpan missing/not an array (got "+JSON.stringify(ly22.monthSpan)+")");
eq(ly22.monthSpan.length===2&&ly22.monthSpan[0].lunarMonth===1&&ly22.monthSpan[0].isLeap===false&&ly22.monthSpan[1].lunarMonth===2&&ly22.monthSpan[1].isLeap===false,"2026-03 monthSpan not [m1,m2] non-leap (got "+JSON.stringify(ly22.monthSpan)+")");
eq(typeof ly22.resolvedAs==="string"&&ly22.resolvedAs.includes("2026-03-15"),"2026-03 resolvedAs missing or lacks sampled date 2026-03-15 (got "+ly22.resolvedAs+")");
eq(ly22.stem==="庚"&&ly22.ambiguousMonth===true,"2026-03 stem/ambiguousMonth changed by span-fields addition");
eq(typeof ly22.note==="string"&&/monthSpan/.test(ly22.note)&&/resolvedAs/.test(ly22.note),"2026-03 note does not point at monthSpan/resolvedAs");
let ly23=R(23).layers.liuyue;
eq(Array.isArray(ly23.monthSpan)&&ly23.monthSpan.length===2&&ly23.monthSpan[0].lunarMonth===11&&ly23.monthSpan[1].lunarMonth===12&&ly23.monthSpan.every(e=>e.isLeap===false),"2026-01 monthSpan not [m11,m12] non-leap (got "+JSON.stringify(ly23.monthSpan)+")");
eq(typeof ly23.resolvedAs==="string"&&ly23.resolvedAs.includes("2026-01-15"),"2026-01 resolvedAs missing or lacks sampled date 2026-01-15 (got "+ly23.resolvedAs+")");
// flowDate payloads must stay BYTE-IDENTICAL to pre-span-fields (no new keys).
for(const id of [17,18]){
  const ly=R(id).layers.liuyue;
  eq(!("monthSpan"in ly)&&!("resolvedAs"in ly),"flowDate id "+id+" payload gained span fields (must stay byte-identical)");
}
// default render byte-identity vs gold
const svgDefault=R(16).svg;
const goldSvg=fs.readFileSync(process.argv[2],"utf8");
eq(svgDefault===goldSvg,"default render SVG NOT byte-identical to gold baseline");
' "$TMP/f.out" "$WS/services/ziwei-mcp/tests/gold/render-default-1986.svg"; then ok "F bugfix+feature regression: lichun stems, rawInput, hours:all, yearWindow, daXianCheck, render overlay, selftest>=10"; else bad "F bugfix+feature regression"; fi

echo "──── A-F: $pass passed, $fail failed"

# ── G: deep-fix regression (2026-11-05 deep review) ───────────────────────────
G="$TMP/g.jsonl"
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ziwei_compatibility","arguments":{"a":{"year":1970,"month":5,"day":15,"hour":10,"minute":0,"gender":"male"},"b":{"year":1988,"month":11,"day":15,"hour":10,"minute":0,"gender":"female"}}}}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ziwei_compatibility","arguments":{"a":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2},"b":{"year":1994,"month":6,"day":15,"hour":8,"minute":0,"gender":"female"}}}}' \
 '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ziwei_compatibility","arguments":{"a":{"year":1960,"month":1,"day":5,"hour":0,"minute":0,"gender":"male"},"b":{"year":1963,"month":7,"day":5,"hour":0,"minute":0,"gender":"male"}}}}' \
 '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":12,"minute":0},"layers":["liuyue"],"lunarMonth":1}}}' \
 '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":12,"minute":0},"layers":["liuyue"],"lunarMonth":12}}}' \
 '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":12,"minute":0},"layers":["liuyue"],"lunarMonth":6,"isLeapMonth":true}}}' \
 '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2023,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":12,"minute":0},"layers":["liuyue"],"lunarMonth":2,"isLeapMonth":true}}}' \
 '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"yearWindow":"丙午","gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":12,"minute":0},"layers":["liunian"]}}}' \
 '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"ziwei_solar_lunar","arguments":{"solar":{"year":1850,"month":6,"day":15}}}}' \
 '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"ziwei_solar_lunar","arguments":{"solar":{"year":2051,"month":6,"day":15}}}}' \
 '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"ziwei_solar_lunar","arguments":{"solar":{"year":2050,"month":6,"day":15}}}}' \
 '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":12,"minute":0},"layers":["liushi"],"flowDate":{"year":2026,"month":11,"day":5},"flowHour":23}}}' \
 '{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"ziwei_sihua_layers","arguments":{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":12,"minute":0},"layers":["liushi"],"flowDate":{"year":2026,"month":11,"day":6},"flowHour":0}}}' \
 '{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":12,"minute":0,"gender":"male","evil":"x"}}}' \
 '{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":12,"minute":0,"gender":"male"}}}' \
 '{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"ziwei_selftest","arguments":{}}}' \
 | "$TSX" "$SRV" > "$TMP/g.out" 2>/dev/null
# m1 four-path agreement table: for 2022-2028, lunarMonth:1 stem must equal the
# stem of the flowDate computed via ziwei_solar_lunar (lunar y-m1-15 -> solar).
# Built as a separate jsonl because it needs solar_lunar + layers per year.
GT="$TMP/g-table.jsonl"
WS="$WS" node -e '
const { Lunar } = require(process.env.WS + "/vendor/ziwei-doushu/node_modules/lunar-javascript/index.js");
const lines = [`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`];
let id = 10;
for (const y of [2022, 2023, 2024, 2025, 2026, 2027, 2028]) {
  const s = Lunar.fromYmd(y, 1, 15).getSolar();
  lines.push(JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "ziwei_solar_lunar", arguments: { lunar: { year: y, month: 1, day: 15 } } } }));
  const birth = { year: 1986, month: 12, day: 8, hour: 12, minute: 0 };
  lines.push(JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "ziwei_sihua_layers", arguments: { year: y, gender: "male", birth, layers: ["liuyue"], lunarMonth: 1 } } }));
  lines.push(JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "ziwei_sihua_layers", arguments: { year: y, gender: "male", birth, layers: ["liuyue"], flowDate: { year: s.getYear(), month: s.getMonth(), day: s.getDay() } } } }));
}
process.stdout.write(lines.join("\n") + "\n");
' > "$GT"
"$TSX" "$SRV" < "$GT" > "$TMP/g-table.out" 2>/dev/null
if node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const g=id=>L.find(x=>x.id===id);
const R=id=>{if(!g(id).result||g(id).result.isError)throw new Error("id "+id+" isError: "+(g(id).result?g(id).result.content[0].text.slice(0,150):"no result"));return JSON.parse(g(id).result.content[0].text)};
const eq=(cond,msg)=>{if(!cond){console.error(msg);process.exit(1)}};
// FIX 1: golden positive pair — A 夫妻(武曲) ⊂ B 命宫(武曲天府) AND B 夫妻(破军) ⊂ A 命宫(破军).
let mt=R(2).findings.mirrorTest;
eq(mt.tianZuoZhiHe===true,"FIX1 golden pair tianZuoZhiHe not true (got "+mt.tianZuoZhiHe+")");
eq(mt.aFuqiStarsInBMing.includes("武曲")&&mt.bFuqiStarsInAMing.includes("破军"),"FIX1 cross-intersection arrays wrong: "+JSON.stringify(mt));
// FIX 1 negative controls must stay false.
eq(R(3).findings.mirrorTest.tianZuoZhiHe===false,"FIX1 negative pair flipped to true");
// FIX 3: flying 忌 lands in partner 夫妻 (searched pair: A 1960-01-05 00:00 male,
// B 1963-07-05 00:00 male — A year stem 戊 -> 文曲化忌, 文曲 sits in B 夫妻).
const jf=R(4).findings.flyingSihua;
jf.jiFlags.forEach(f=>{}); // structural only
const hasFuqiFlag=jf.jiFlags.some(f=>/化忌入对方夫妻宫/.test(f));
eq(hasFuqiFlag,"FIX3 jiFlags 夫妻 flag dead — no 化忌入对方夫妻宫 for known-good pair: "+JSON.stringify(jf.jiFlags));
eq(jf.aToB.transforms["忌"].palaceInOther==="夫妻","FIX3 A->B 忌 palace not 夫妻 (got "+jf.aToB.transforms["忌"].palaceInOther+")");
// FIX 2: direct lunarMonth path — 2026 m1 -> 庚 (丙午), NOT 戊 (old bug: 乙巳).
let ly=R(5).layers.liuyue;
eq(ly.stem==="庚","FIX2 2026 lunarMonth:1 stem not 庚 (got "+ly.stem+")");
eq(ly.ganzhiYear==="丙午","FIX2 2026 lunarMonth:1 ganzhiYear not 丙午 (got "+ly.ganzhiYear+")");
// m12 edge: 2026 丙午 m12 stays 辛 (mid-month lands in early 2027 pre-lichun).
ly=R(6).layers.liuyue;
eq(ly.stem==="辛","FIX2 2026 lunarMonth:12 stem not 辛 (got "+ly.stem+")");
// isLeapMonth validation: 2026 has no leap month -> isError.
if(!g(7).result||g(7).result.isError!==true){console.error("FIX2 isLeapMonth:true on leap-less year not isError");process.exit(1)}
// 2023 闰二月 (real leap) resolves: stem 乙 (癸卯 base-month stem), isLeapMonth true.
ly=R(8).layers.liuyue;
eq(ly.stem==="乙"&&ly.isLeapMonth===true,"FIX2 2023 leap m2 wrong (stem "+ly.stem+" isLeap "+ly.isLeapMonth+")");
// 5b: year + yearWindow together -> isError (both standalone paths still work).
if(!g(9).result||g(9).result.isError!==true){console.error("5b year+yearWindow not isError");process.exit(1)}
if(!/not both/.test(g(9).result.content[0].text)){console.error("5b error message wrong: "+g(9).result.content[0].text);process.exit(1)}
// 5c: solar->lunar bounded 1900-2050.
if(!g(10).result||g(10).result.isError!==true){console.error("5c solar 1850 not isError");process.exit(1)}
if(!g(11).result||g(11).result.isError!==true){console.error("5c solar 2051 not isError");process.exit(1)}
if(g(12).result.isError){console.error("5c solar 2050 (in range) rejected");process.exit(1)}
// 5d: liushi 23:xx uses NEXT day stem/branch, matching next-day h0.
const l13=R(13).layers.liushi, l14=R(14).layers.liushi;
eq(l13.solarDate==="2026-11-06","5d h23 solarDate not day-shifted (got "+l13.solarDate+")");
eq(l13.dayShiftFromLateZi===1,"5d h23 dayShiftFromLateZi missing");
eq(l13.dayStemBranch===l14.dayStemBranch&&l13.stem===l14.stem,"5d h23 layer != next-day h0 layer (got "+l13.dayStemBranch+" vs "+l14.dayStemBranch+")");
// 5a: unknown args echoed, not silently dropped.
eq(Array.isArray(R(15).meta.ignoredKeys)&&R(15).meta.ignoredKeys.includes("evil"),"5a ignoredKeys missing for evil:x call");
eq(!("ignoredKeys" in R(16).meta),"5a ignoredKeys present on clean call");
// selftest >=13 incl. the new lunarMonthDirect check.
const st=R(17);
eq(st.pass===true,"selftest not pass");
eq(st.checks.length>=13,"selftest checks <13 (got "+st.checks.length+")");
eq(st.checks.some(c=>c.name==="lunarMonthDirect2026"&&c.expected==="庚"&&c.ok),"selftest missing lunarMonthDirect2026 check");
' "$TMP/g.out"; then ok "G deep-fix: mirror cross-check, jiFlags 夫妻 live, year/yearWindow reject, solar bounds, liushi day-shift, ignoredKeys, selftest>=13"; else bad "G deep-fix core"; fi
if node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const g=id=>L.find(x=>x.id===id);
const R=id=>{if(!g(id).result||g(id).result.isError)throw new Error("id "+id+" isError");return JSON.parse(g(id).result.content[0].text)};
const eq=(cond,msg)=>{if(!cond){console.error(msg);process.exit(1)}};
// Four-path agreement: lunarMonth:1 stem === flowDate(lunar m1 mid).stem for 2022-2028.
for(let i=0;i<7;i++){
  const base=10+i*3;
  const sl=R(base).solar;
  const lm=R(base+1).layers.liuyue;
  const fd=R(base+2).layers.liuyue;
  eq(lm.stem===fd.stem,"year "+(2022+i)+" lunarMonth:1 stem "+lm.stem+" != flowDate stem "+fd.stem);
  eq(fd.lunarMonth===1,"year "+(2022+i)+" flowDate m1-mid not lunar m1 (got "+fd.lunarMonth+")");
  eq(sl.month>=1&&sl.month<=12,"year "+(2022+i)+" solar_lunar m1-mid bad");
}
eq([2022,2023,2024,2025,2026,2027,2028].every((y,i)=>R(11+i*3).layers.liuyue.stem===["壬","甲","丙","戊","庚","壬","甲"][i]),"m1 stem table mismatch vs expected 壬甲丙戊庚壬甲");
' "$TMP/g-table.out"; then ok "G four-path agreement: m1 stems 2022-2028 via flowDate cross-check"; else bad "G four-path table"; fi

echo "──── A-G: $pass passed, $fail failed"

# ── H: batch-stats memory resilience (2026-11-11) ────────────────────────────
# The 12-worker batch on a memory-tight box used to oom-kill the child
# (exit 137) and surface as a 120 s timeout. With the free-memory clamp
# (batch-stats-worker.mts, ~512 MB/worker) the same call must now complete,
# report a sane worker count, and stay under the timeout.
H="$TMP/h.jsonl"
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ziwei_batch_stats","arguments":{"question":"wuxingJu-distribution","gender":"male","yearFrom":1950,"yearTo":1950,"hours":"all"}}}' \
 | "$TSX" "$SRV" > "$TMP/h.out" 2>/dev/null
if node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const g=L.find(x=>x.id===2);
if(!g.result||g.result.isError){console.error("batch-stats isError: "+(g.result?g.result.content[0].text.slice(0,200):"no result"));process.exit(1)}
const d=JSON.parse(g.result.content[0].text);
if(d.chartsComputed!==4380){console.error("chartsComputed not 4380 (got "+d.chartsComputed+")");process.exit(1)}
const sum=Object.values(d.distribution).reduce((a,b)=>a+b,0);
if(sum!==d.chartsComputed){console.error("sum(distribution) "+sum+" != chartsComputed "+d.chartsComputed);process.exit(1)}
const memBound=Math.max(1,Math.floor(require("os").freemem()/(256*1024*1024)));
if(!Number.isInteger(d.workers)||d.workers<1||d.workers>12||d.workers>memBound){console.error("workers "+d.workers+" out of bounds [1..12] ∩ [1.."+memBound+"] (free-mem bound)");process.exit(1)}
process.stdout.write(String(d.workers));
' "$TMP/h.out" > "$TMP/h.workers"; then
  ok "H batch-stats memory resilience: 4380 charts, sum==chartsComputed, workers=$(cat "$TMP/h.workers") (≤ free-mem bound)"; else bad "H batch-stats memory resilience"; fi

echo "──── A-H: $pass passed, $fail failed"

# ── I: ziwei_patterns coverage (2026-11-12 full-coverage pass) ────────────────
# Thin tool before this pass: only listed in EXPECTED (A) and called once via
# selftest fixtures. Here: gold-chart general detectors, the two strict 《全书》
# 卷一 table fixtures (定贵局第11条 七杀朝斗 / 第9条 坐贵向贵), the 空宫借星
# edge (empty 命宫 → borrowedFrom), validation errors, and leapMonth echo.
I="$TMP/i.jsonl"
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ziwei_patterns","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ziwei_patterns","arguments":{"year":1978,"month":7,"day":1,"hour":11,"minute":0,"gender":"male"}}}' \
 '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ziwei_patterns","arguments":{"year":1990,"month":5,"day":20,"hour":8,"minute":0,"gender":"female"}}}' \
 '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"ziwei_patterns","arguments":{}}}' \
 '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"ziwei_patterns","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","leapMonth":"bogus"}}}' \
 '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ziwei_patterns","arguments":{"year":2023,"month":4,"day":10,"hour":12,"minute":0,"gender":"male","leapMonth":"prev-month"}}}' \
 | "$TSX" "$SRV" > "$TMP/i.out" 2>/dev/null
if node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const g=id=>L.find(x=>x.id===id);
const R=id=>{if(!g(id).result||g(id).result.isError)throw new Error("id "+id+" isError: "+(g(id).result?g(id).result.content[0].text.slice(0,150):"no result"));return JSON.parse(g(id).result.content[0].text)};
const eq=(cond,msg)=>{if(!cond){console.error(msg);process.exit(1)}};
// gold birth: general detectors fire, zero strict 卷一 entries (documented
// anchor — the gold 命宮 is 天同太阴 in 子; none of the 49 strict entries match).
const r2=R(2);
eq(r2.counts.total>=1&&r2.counts.strict===0,"gold patterns counts wrong: "+JSON.stringify(r2.counts));
eq(r2.patterns.every(p=>p.name&&p.level&&p.description&&Array.isArray(p.palaces)&&typeof p.strict==="boolean"),"pattern entries malformed");
eq(r2.patterns.some(p=>p.name==="机月同梁"),"gold 机月同梁 missing");
eq(r2.patterns.some(p=>p.name==="天同化禄入命"),"gold 天同化禄入命 missing");
eq(r2.mingGong.branch==="子"&&r2.mingGong.mainStars.includes("天同"),"gold mingGong wrong");
eq(!("borrowedFrom" in r2.mingGong),"non-empty mingGong must not carry borrowedFrom");
eq(r2.meta.leapMonth==="split (engine default)","default leapMonth echo wrong: "+r2.meta.leapMonth);
// fixture A: strict 定贵局第11条 七杀朝斗 (source tagged 卷一), plus loose bonus detectors
eq(g(3).result.isError!==true,"fixture A isError");
const r3=R(3);
eq(r3.counts.strict>=1,"fixture A no strict entries");
const s3=r3.patterns.find(p=>p.name==="七杀朝斗");
eq(s3&&s3.strict===true&&/·卷一·定贵局》第11条/.test(s3.source||""),"fixture A 七杀朝斗 strict entry wrong: "+JSON.stringify(s3));
eq(/原书第11条/.test(s3.description),"fixture A strict description lacks 原书注文");
eq(r3.patterns.some(p=>p.name==="杀破狼"&&p.strict===false),"fixture A loose 杀破狼 bonus missing");
eq(r3.mingGong.mainStars.includes("七杀"),"fixture A mingGong stars wrong");
// fixture B: 空宫借星 — empty 命宫 in 丑 borrows 太阳太阴 from 迁移
eq(g(4).result.isError!==true,"fixture B isError");
const r4=R(4);
eq(r4.mingGong.mainStars.length===0&&r4.mingGong.nature==="空宫","fixture B mingGong not empty: "+JSON.stringify(r4.mingGong));
eq(r4.mingGong.borrowedFrom&&r4.mingGong.borrowedFrom.palace==="迁移"&&r4.mingGong.borrowedFrom.mainStars.includes("太阳")&&r4.mingGong.borrowedFrom.mainStars.includes("太阴"),"fixture B borrowedFrom wrong: "+JSON.stringify(r4.mingGong.borrowedFrom));
eq(r4.patterns.some(p=>p.name==="坐贵向贵"&&p.strict===true&&/定贵局》第9条/.test(p.source||"")),"fixture B 坐贵向贵 strict entry missing");
// validation: missing args + bad leapMonth enum
if(!g(5).result||g(5).result.isError!==true){console.error("patterns {} not isError");process.exit(1)}
if(!g(6).result||g(6).result.isError!==true||!/leapMonth must be one of/.test(g(6).result.content[0].text)){console.error("patterns bad leapMonth not isError-with-enum");process.exit(1)}
// leapMonth policy honored through the patterns path (2023 leap year, prev-month
// shifts 命宮 to 天府/木三局) and echoed in meta + rawInput.
const r7=R(7);
eq(r7.meta.leapMonth==="prev-month"&&r7.meta.rawInput.leapMonth==="prev-month","patterns leapMonth echo wrong");
eq(r7.mingGong.branch==="酉"&&r7.mingGong.mainStars.includes("天府"),"patterns leapMonth=prev-month chart not shifted: "+JSON.stringify(r7.mingGong));
' "$TMP/i.out"; then ok "I patterns: gold detectors + strict 定贵局 fixtures + 空宫借星 + validation + leapMonth"; else bad "I patterns"; fi

# ── J: ziwei_school_compare coverage (2026-11-12 full-coverage pass) ──────────
# Thin tool before this pass: one gold-birth call in E. Here: all 6 variants
# present, zero-diff baselines, and the discriminating cases — late-zi birth
# separates lateZishi variants; leap-year birth separates leapMonth policies;
# non-leap birth collapses every leapMonth variant to zero diffs.
J="$TMP/j.jsonl"
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ziwei_school_compare","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ziwei_school_compare","arguments":{"year":2023,"month":4,"day":10,"hour":12,"minute":0,"gender":"male"}}}' \
 '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ziwei_school_compare","arguments":{"year":1986,"month":12,"day":8,"hour":12,"minute":0,"gender":"male"}}}' \
 '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"ziwei_school_compare","arguments":{"year":1986,"month":13,"day":1,"hour":12,"minute":0,"gender":"male"}}}' \
 | "$TSX" "$SRV" > "$TMP/j.out" 2>/dev/null
if node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const g=id=>L.find(x=>x.id===id);
const R=id=>{if(!g(id).result||g(id).result.isError)throw new Error("id "+id+" isError: "+(g(id).result?g(id).result.content[0].text.slice(0,150):"no result"));return JSON.parse(g(id).result.content[0].text)};
const eq=(cond,msg)=>{if(!cond){console.error(msg);process.exit(1)}};
const VARIANTS=["lateZishi=next-day (default)","lateZishi=current-day (倪师派)","leapMonth=split (default)","leapMonth=next-month (倪师派)","leapMonth=prev-month","leapMonth=origin-month"];
const r2=R(2);
eq(JSON.stringify(r2.meta.comparedVariants)===JSON.stringify(VARIANTS),"variant roster wrong: "+JSON.stringify(r2.meta.comparedVariants));
eq(r2.variants[VARIANTS[0]].diffFromDefault.length===0,"default variant not zero-diff");
eq(r2.variants["leapMonth=split (default)"].diffFromDefault.length===0,"split variant not zero-diff");
// gold is a late-zi birth: current-day must differ (incl. effectiveDate),
// every leapMonth policy must NOT (no leap month in the chart window).
eq(r2.variants["lateZishi=current-day (倪师派)"].diffFromDefault.length>0,"late-zi birth: current-day zero-diff");
eq(r2.variants["lateZishi=current-day (倪师派)"].diffFromDefault.some(d=>d.startsWith("effectiveDate")),"current-day diff lacks effectiveDate");
for(const k of ["leapMonth=next-month (倪师派)","leapMonth=prev-month","leapMonth=origin-month"])eq(r2.variants[k].diffFromDefault.length===0,"gold leapMonth variant "+k+" differs unexpectedly");
// leap-year birth (2023-04-10, inside 闰二月): split/next-month agree with
// baseline; prev-month/origin-month shift the whole chart (命宮 + 五行局).
const r3=R(3);
eq(r3.variants["lateZishi=current-day (倪师派)"].diffFromDefault.length===0,"2023 birth: current-day differs unexpectedly (not late-zi)");
eq(r3.variants["leapMonth=next-month (倪师派)"].diffFromDefault.length===0,"2023 next-month differs from split unexpectedly");
for(const k of ["leapMonth=prev-month","leapMonth=origin-month"]){
  const d=r3.variants[k].diffFromDefault;
  eq(d.length>0,"2023 "+k+" zero-diff (leap policy not honored)");
  eq(d.some(x=>x.startsWith("命宮"))&&d.some(x=>x.startsWith("五行局")),"2023 "+k+" diff missing 命宮/五行局: "+JSON.stringify(d.slice(0,3)));
}
eq(r3.variants["leapMonth=prev-month"].digest.wuxingJu==="木三局","2023 prev-month wuxingJu not 木三局: "+r3.variants["leapMonth=prev-month"].digest.wuxingJu);
// digest shape: 12 palaces, sorted majors, fourPillars joined
const dg=r3.variants[VARIANTS[0]].digest;
eq(dg.palaces.length===12&&dg.fourPillars.includes("/")&&dg.palaces.every(p=>p.name&&p.branch&&Array.isArray(p.majors)),"digest shape wrong");
// non-leap birth: ALL leapMonth variants collapse to zero diffs
const r4=R(4);
for(const k of ["leapMonth=next-month (倪师派)","leapMonth=prev-month","leapMonth=origin-month"])eq(r4.variants[k].diffFromDefault.length===0,"non-leap birth "+k+" differs unexpectedly");
// validation: month 13 -> isError
if(!g(5).result||g(5).result.isError!==true){console.error("school_compare month 13 not isError");process.exit(1)}
' "$TMP/j.out"; then ok "J school-compare: 6 variants, late-zi/leap-year/non-leap discrimination, digest shape, validation"; else bad "J school-compare"; fi

# ── K: leapMonth parameter coverage across calendar-aware tools (2026-11-12) ──
# The leapMonth (闰月) policy is accepted by ziwei_chart/ziwei_patterns (and
# compared by ziwei_school_compare); ziwei_from_city documents it as ignored.
# Anchor: 2023-04-10 12:00 male — inside 2023 闰二月, so split/next-month
# resolve to 三月 (天机天梁, 水二局) while prev-month/origin-month resolve to
# 二月 (天府, 木三局). Default must equal split. solar_lunar exercises the
# leap flag both directions; from_city must echo leapMonth in ignoredKeys.
K="$TMP/k.jsonl"
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":2023,"month":4,"day":10,"hour":12,"minute":0,"gender":"male","leapMonth":"split"}}}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":2023,"month":4,"day":10,"hour":12,"minute":0,"gender":"male","leapMonth":"next-month"}}}' \
 '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":2023,"month":4,"day":10,"hour":12,"minute":0,"gender":"male","leapMonth":"prev-month"}}}' \
 '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":2023,"month":4,"day":10,"hour":12,"minute":0,"gender":"male","leapMonth":"origin-month"}}}' \
 '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":2023,"month":4,"day":10,"hour":12,"minute":0,"gender":"male"}}}' \
 '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":2023,"month":4,"day":10,"hour":12,"minute":0,"gender":"male","leapMonth":"bogus"}}}' \
 '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"ziwei_from_city","arguments":{"year":2023,"month":4,"day":10,"hour":12,"minute":0,"gender":"male","city":"Hong Kong","leapMonth":"prev-month"}}}' \
 '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"ziwei_solar_lunar","arguments":{"lunar":{"year":2023,"month":2,"isLeap":true,"day":15}}}}' \
 '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"ziwei_solar_lunar","arguments":{"solar":{"year":2023,"month":4,"day":5}}}}' \
 '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"ziwei_solar_lunar","arguments":{"lunar":{"year":2023,"month":2,"day":15}}}}' \
 '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"ziwei_solar_lunar","arguments":{"lunar":{"year":2023,"month":2,"isLeap":true,"day":1}}}}' \
 | "$TSX" "$SRV" > "$TMP/k.out" 2>/dev/null
if node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const g=id=>L.find(x=>x.id===id);
const R=id=>{if(!g(id).result||g(id).result.isError)throw new Error("id "+id+" isError: "+(g(id).result?g(id).result.content[0].text.slice(0,150):"no result"));return JSON.parse(g(id).result.content[0].text)};
const eq=(cond,msg)=>{if(!cond){console.error(msg);process.exit(1)}};
const dig=id=>{const r=R(id);const mg=r.chart.palaces.find(p=>p.isMingGong);return [r.chart.lunarInfo.lunarMonth,mg.stars.filter(s=>s.type==="major").map(s=>s.name).sort().join("+"),r.chart.wuxingJuName].join("|")};
// split/next-month agree: 三月 天机天梁 水二局; prev-month/origin-month agree:
// 二月 天府 木三局. Default == split (documented engine default).
eq(dig(2)==="3|天机+天梁|水二局","split wrong: "+dig(2));
eq(dig(3)===dig(2),"next-month != split");
eq(dig(4)==="2|天府|木三局","prev-month wrong: "+dig(4));
eq(dig(5)===dig(4),"origin-month != prev-month");
eq(dig(6)===dig(2),"default != split");
eq(R(2).meta.leapMonth===undefined||/split/.test(String(R(2).meta.leapMonth)),"default leapMonth echo wrong");
eq(R(4).meta.rawInput.leapMonth==="prev-month","rawInput leapMonth echo wrong");
// invalid enum rejected
if(!g(7).result||g(7).result.isError!==true||!/leapMonth must be one of/.test(g(7).result.content[0].text)){console.error("chart bad leapMonth not isError");process.exit(1)}
// from_city: accepted but ignored (schema has no leapMonth) — echoed via
// ignoredKeys, chart follows the split default (三月 天机天梁).
const r8=R(8);
eq(Array.isArray(r8.meta.ignoredKeys)&&r8.meta.ignoredKeys.includes("leapMonth"),"from_city leapMonth not in ignoredKeys: "+JSON.stringify(r8.meta.ignoredKeys));
const mg8=r8.chart.palaces.find(p=>p.isMingGong);
eq(r8.chart.lunarInfo.lunarMonth===3&&mg8.stars.filter(s=>s.type==="major").map(s=>s.name).sort().join("+")==="天机+天梁","from_city leapMonth changed the chart");
// solar_lunar leap-flag round-trips: 闰二月十五 <-> 2023-04-05; non-leap 二月
// 十五 lands a month earlier (2023-03-06); 闰二月初一 = 2023-03-22.
const r9=R(9), r10=R(10);
eq(r9.lunar.isLeap===true&&r9.solar.year===2023&&r9.solar.month===4&&r9.solar.day===5,"leap m2 m15 -> solar wrong: "+JSON.stringify(r9.solar));
eq(r10.lunar.month===2&&r10.lunar.isLeap===true&&r10.lunar.day===15,"solar->leap m2 flag wrong: "+JSON.stringify(r10.lunar));
const r11=R(11);
eq(r11.lunar.isLeap===false&&r11.solar.month===3&&r11.solar.day===6,"non-leap m2 15 -> 2023-03-06 wrong: "+JSON.stringify(r11.solar));
const r12=R(12);
eq(r12.lunar.isLeap===true&&r12.solar.month===3&&r12.solar.day===22,"leap m2 d1 -> 2023-03-22 wrong: "+JSON.stringify(r12.solar));
' "$TMP/k.out"; then ok "K leapMonth: chart policy table (split/next/prev/origin/default), enum reject, from_city ignoredKeys, solar_lunar leap round-trips"; else bad "K leapMonth"; fi

echo "──── A-K: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

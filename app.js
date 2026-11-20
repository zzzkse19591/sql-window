/* 데이터에 묻는 창 — 화면.
 *
 * DuckDB-WASM 이 브라우저 안에서 parquet 을 읽는다. 표는 SQL에 나오는 것만 그때그때 받는다.
 * AI(api/sql)에는 질문 문장과 표 설명만 보낸다. 데이터는 보내지 않는다.
 * 실행하는 SQL은 전부 «읽기 전용» 검사를 거친다 — AI가 쓴 것이든 사람이 쓴 것이든.
 */
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";

const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const S = { db: null, conn: null, loaded: new Set(), schema: null, questions: [], files: [], mine: {} };

// ── 엔진 ─────────────────────────────────────────────
async function startEngine() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  S.db = db;
  S.conn = await db.connect();
}

async function ensureTables(sql) {
  const names = Object.keys(S.schema.tables).filter(t => new RegExp(`\\b${t}\\b`, "i").test(sql));
  for (const t of names) {
    if (S.loaded.has(t)) continue;
    $("#engine").textContent = `표 «${t}» 받는 중…`;
    const buf = new Uint8Array(await (await fetch(`data/${t}.parquet`)).arrayBuffer());
    await S.db.registerFileBuffer(`${t}.parquet`, buf);
    await S.conn.query(`CREATE VIEW ${t} AS SELECT * FROM '${t}.parquet'`);
    S.loaded.add(t);
  }
  engineLine();
}

function engineLine() {
  const mine = Object.keys(S.mine);
  $("#engine").textContent = mine.length
    ? `내 파일로 묻는 중 · ${mine.map(t => `${t} ← ${S.mine[t].file}`).join(" · ")}`
    : `준비됨 · 불러온 표 ${S.loaded.size}개 / ${Object.keys(S.schema.tables).length}개`;
  $("#engine").classList.add("ready");
}

// ── 내 파일로 — 엑셀 · CSV 를 이 브라우저 안에서 표로 올린다 ─────────────
// 파일 이름에 questions.json 의 files[].match 가 들어 있으면 그 표를 대신한다.
function tableFor(name) {
  const hit = S.files.find(f => name.includes(f.match));
  return hit ? hit.table : null;
}

async function loadMine(fileList) {
  for (const f of fileList) {
    const table = tableFor(f.name);
    const item = document.createElement("div");
    item.className = "mine";
    $("#mine-list").appendChild(item);
    if (!table) {
      item.innerHTML = `<span class="no">✕</span> ${esc(f.name)} — 이 파일에 맞는 표가 없습니다. 파일 이름에 ${S.files.map(x => `«${esc(x.match)}»`).join(" · ")} 가운데 하나가 들어 있어야 합니다`;
      continue;
    }
    item.innerHTML = `${esc(f.name)} 읽는 중…`;
    const buf = new Uint8Array(await f.arrayBuffer());
    const isCsv = /\.csv$/i.test(f.name);
    const wb = isCsv
      ? XLSX.read(new TextDecoder("utf-8").decode(buf).replace(/^﻿/, ""), { type: "string", raw: true })
      : XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const read = XLSX.utils.sheet_to_json(ws, { defval: "" }).length;
    const csv = XLSX.utils.sheet_to_csv(ws);
    const tmp = `mine_${table}.csv`;
    await S.db.registerFileText(tmp, csv);
    await S.conn.query(`DROP VIEW IF EXISTS ${table}`);
    await S.conn.query(`CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_csv('${tmp}', header = true, auto_detect = true)`);
    const n = Number((await S.conn.query(`SELECT count(*) AS n FROM ${table}`)).toArray()[0].n);
    S.loaded.add(table);
    S.mine[table] = { file: f.name, rows: n };
    const ok = n === read;
    item.innerHTML = `<span class="${ok ? "ok" : "no"}">${ok ? "✓" : "✕"}</span> <b>${esc(f.name)}</b> → 표 <code>${table}</code> · `
      + `파일에서 읽은 줄 ${read.toLocaleString("ko-KR")} · 표에 올라간 줄 ${n.toLocaleString("ko-KR")}`
      + (wb.SheetNames.length > 1 ? ` · ⚠ 시트 ${wb.SheetNames.length}개 중 첫 시트만 읽었습니다` : "");
  }
  $("#btn-mine-reset").hidden = !Object.keys(S.mine).length;
  engineLine();
  document.querySelectorAll(".q .out").forEach(o => { o.innerHTML = ""; });
}

// ── 읽기 전용 검사 (api/sql.py 와 같은 규칙) ───────────────
const FORBIDDEN = /\b(insert|update|delete|drop|create|alter|attach|detach|copy|pragma|install|load|export|import|call|set)\b/i;
function readOnly(sql) {
  const s = String(sql || "").replace(/--[^\n]*/g, "").trim().replace(/;\s*$/, "").trim();
  if (!s || s.includes(";")) return null;
  if (!/^(select|with)\b/i.test(s)) return null;
  if (FORBIDDEN.test(s.replace(/'[^']*'/g, "''"))) return null;
  return s;
}

// ── 실행 ─────────────────────────────────────────────
async function run(sql) {
  const safe = readOnly(sql);
  if (!safe) throw new Error("읽기(SELECT · WITH)만 실행합니다. 한 문장만, 바꾸는 명령 없이.");
  await ensureTables(safe);
  let t = await S.conn.query(safe);
  // 소수 자리가 정해진 숫자(DECIMAL)는 화면에서 읽기 어려운 모양으로 온다 — 보통 숫자로 바꿔 다시 받는다
  const dec = t.schema.fields.filter(f => String(f.type).startsWith("Decimal"));
  if (dec.length) {
    const cols = t.schema.fields.map(f => dec.includes(f) ? `"${f.name}"::DOUBLE AS "${f.name}"` : `"${f.name}"`);
    t = await S.conn.query(`SELECT ${cols.join(", ")} FROM (${safe})`);
  }
  const fields = t.schema.fields.map(f => f.name);
  const rows = t.toArray().map(r => {
    const o = {};
    fields.forEach(f => { const v = r[f]; o[f] = typeof v === "bigint" ? Number(v) : v; });
    return o;
  });
  return { fields, rows };
}

function fmt(v) {
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("ko-KR") : String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return esc(v);
}

function render({ fields, rows }) {
  const head = `<tr>${fields.map(f => `<th>${esc(f)}</th>`).join("")}</tr>`;
  const body = rows.slice(0, 50).map(r => `<tr>${fields.map(f =>
    `<td class="${typeof r[f] === "number" ? "n" : ""}">${fmt(r[f])}</td>`).join("")}</tr>`).join("");
  let html = `<div class="res"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  if (rows.length > 50) html += `<p class="small muted">… ${rows.length}줄 중 50줄만 보여줍니다</p>`;
  // 막대 — 첫 열이 글자이고 마지막 열이 숫자일 때
  const last = fields[fields.length - 1];
  if (rows.length > 1 && rows.length <= 20 && typeof rows[0][fields[0]] === "string" && typeof rows[0][last] === "number") {
    const max = Math.max(...rows.map(r => Math.abs(r[last]))) || 1;
    html += `<div class="bars">` + rows.map(r => `<div class="bar"><span class="l">${esc(r[fields[0]])}</span>`
      + `<span class="t"><i style="width:${(Math.abs(r[last]) / max) * 100}%"></i></span><span class="v">${fmt(r[last])}</span></div>`).join("") + `</div>`;
  }
  return html;
}

function checks(q, res) {
  return `<div class="checks">` + q.check.map(c => {
    const hit = res.rows.find(r => Object.entries(c.where || {}).every(([k, v]) => r[k] === v));
    const got = hit ? hit[c.col] : undefined;
    const ok = typeof got === "number" && Math.abs(got - c.want) < 1e-9;
    const where = Object.values(c.where || {}).join(" ");
    return `<span class="${ok ? "ok" : "no"}">${ok ? "✓" : "✕"} ${esc(where)} ${esc(c.col)} ${fmt(c.want)}</span>`;
  }).join("") + (Object.keys(S.mine).some(t => new RegExp(`\\b${t}\\b`, "i").test(q.sql))
    ? `<span class="muted">← 확인할 값은 목업 데이터의 값입니다. 내 파일에서는 달라도 됩니다</span>`
    : `<span class="muted">← 실측결과와 대조</span>`) + `</div>`;
}

// ── 준비한 질문 ───────────────────────────────────────
function renderQuestions() {
  $("#qlist").innerHTML = S.questions.map(q => `
    <div class="q" id="q-${q.id}">
      <h4 data-q="${q.id}">${esc(q.q)}</h4>
      <div class="body" hidden>
        <div class="judge">${esc(q.judge)}</div>
        <pre class="sql">${esc(q.sql)}</pre>
        <div class="row"><button class="primary" data-run="${q.id}">실행</button>
          <button class="ghost" data-edit="${q.id}">고쳐서 묻기</button></div>
        <div class="out"></div>
      </div>
    </div>`).join("");
  document.querySelectorAll("[data-q]").forEach(h => h.addEventListener("click", () => {
    const b = h.parentElement.querySelector(".body"); b.hidden = !b.hidden;
  }));
  document.querySelectorAll("[data-run]").forEach(b => b.addEventListener("click", async () => {
    const q = S.questions.find(x => x.id === b.dataset.run);
    const out = b.closest(".q").querySelector(".out");
    b.disabled = true; b.textContent = "실행 중…";
    try { const res = await run(q.sql); out.innerHTML = render(res) + checks(q, res); out.dataset.done = "1"; }
    catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    b.disabled = false; b.textContent = "실행";
  }));
  document.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => {
    $("#sql").value = S.questions.find(x => x.id === b.dataset.edit).sql;
    document.querySelector("[data-tab=ask]").click();
  }));
}

// ── 직접 묻기 ─────────────────────────────────────────
$("#btn-run").addEventListener("click", async () => {
  const b = $("#btn-run");
  b.disabled = true; b.textContent = "실행 중…";
  try { $("#ask-out").innerHTML = render(await run($("#sql").value)); }
  catch (e) { $("#ask-out").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  b.disabled = false; b.textContent = "실행";
});

$("#btn-nl").addEventListener("click", async () => {
  const q = $("#nl").value.trim();
  if (!q) return;
  const b = $("#btn-nl"); b.disabled = true; b.textContent = "AI가 SQL을 쓰는 중…";
  let r;
  try {
    const res = await fetch("api/sql", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, schema: S.schema }) });
    r = res.ok ? await res.json() : { sql: null, reason: `서버 함수가 없습니다 (${res.status}) — 배포하면 생깁니다` };
  } catch (e) { r = { sql: null, reason: "서버 함수에 닿지 못했습니다" }; }
  $("#nl-msg").hidden = false;
  if (r.sql) {
    $("#sql").value = r.sql;
    $("#nl-msg").textContent = `AI가 쓴 SQL입니다 — ${r.why || ""} · 실행 전에 읽어 보고, 결과 하나는 손으로 검산하십시오.`;
  } else {
    $("#nl-msg").textContent = `SQL을 만들지 못했습니다 — ${r.reason}. 아래 SQL을 직접 고쳐서 실행할 수 있습니다.`;
  }
  b.disabled = false; b.textContent = "SQL 만들기 (AI)";
});

// ── 표 보기 ───────────────────────────────────────────
function renderTables() {
  $("#schema-note").textContent = S.schema.note;
  $("#tables").innerHTML = Object.entries(S.schema.tables).map(([t, i]) => `
    <div class="tbl"><b>${esc(t)}</b> · <span class="g">한 줄 = ${esc(i.grain)}</span> · ${i.rows.toLocaleString("ko-KR")}행<br>
      <span class="muted">${i.columns.map(c => esc(c.name) + (c.values ? ` <small>(${c.values.map(esc).join("·")})</small>` : "")).join(", ")}</span></div>`).join("");
}

// ── 탭 ───────────────────────────────────────────────
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
  ["preset", "ask", "tables", "mine"].forEach(k => { $("#tab-" + k).hidden = k !== b.dataset.tab; });
}));

// ── 내 파일로 — 넣기 ─────────────────────────────────────
$("#mine-file").addEventListener("change", e => { if (e.target.files.length) loadMine([...e.target.files]); });
const drop = $("#drop");
["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => { if (e.dataTransfer.files.length) loadMine([...e.dataTransfer.files]); });
$("#btn-mine-reset").addEventListener("click", () => location.reload());

// ── 시작 ─────────────────────────────────────────────
(async () => {
  const [sch, qs] = await Promise.all([fetch("schema.json").then(r => r.json()), fetch("questions.json").then(r => r.json())]);
  S.schema = sch; S.questions = qs.questions; S.files = qs.files || [];
  renderQuestions(); renderTables();
  $("#mine-rule").textContent = S.files.length
    ? "파일 이름으로 표를 고릅니다 — " + S.files.map(f => `«${f.match}»가 든 파일 → ${f.table}`).join(" · ")
    : "questions.json 에 files 가 없어 내 파일을 받을 수 없습니다";
  try {
    await startEngine();
    $("#engine").textContent = "준비됨 · 표는 질문에 나올 때 받습니다";
    $("#engine").classList.add("ready");
    document.body.dataset.engine = "ready";
  } catch (e) {
    $("#engine").textContent = "데이터 엔진을 불러오지 못했습니다 — 인터넷 연결을 확인하십시오";
    document.body.dataset.engine = "fail";
  }
})();

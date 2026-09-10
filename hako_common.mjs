// hako_common.mjs — 箱庭の node スクリプト（hako_miner / hako_test_payer / これからの client・worker）が共有する会場 I/O。
// 元は ~/technocore-inference-market/tclk/payee.mjs の loadSigner / req / refusal / readTail / post / notes。
// 足したもの:
//   - post() の「門」の再送: 派生ルームは払う側の lock の投稿で作られる。部屋の総数が上限に当たると technocore は
//     400 `room limit reached (<cap> is the cap, and this would be a new one). …`（store.py _at_capacity → app.py on_bad_input）を返す。
//     このときだけ、同じ署名（nonce も本文も同じ）を GATE_INTERVAL_MS（既定 30 秒）ごとに opts.gateUntilMs（その契約の claimByMs）まで
//     再送する（~/hako_open.sh と同じ方式）。ほかの 400（nonce 順、重複フィルタなど）は再送しない
//   - readSince(): `GET /r/<room>?since=<seq>&limit=<n>` で差分を追う（/r/tclk-offers は最新 50 件では取りこぼす）
//   - fetchExport(): `GET /r/<room>/export` を丸ごと（X-Room-Generation 付き）
//   - fileLog(): 1 行ずつファイルに残す
import { readFileSync, appendFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dns from "node:dns";

// 自宅回線は IPv6 が通らず待たされる（9/9 実測。hako_export.py と同じ）。既定で IPv4 を先に引く
if (process.env.HAKO_IPV6 !== "1") dns.setDefaultResultOrder("ipv4first");

export const TCLK = process.env.TCLK_DIR ?? path.join(homedir(), "tclk");
export const core = await import(pathToFileURL(path.join(TCLK, "dist/index.js")).href);
export const signing = await import(pathToFileURL(path.join(TCLK, "mcp/dist/signing.js")).href);
const { encodeFrame } = core;
const { canonicalMessage, nextNonce, signerFromSeed, sweep } = signing;

export const BASE = process.env.TECHNOCORE_URL ?? "https://technocore.chat";
export const GATE_TEXT = "room limit reached";                                   // 9/9 実物: 400 room limit reached (163840 is the cap, and this would be a new one). …
export const GATE_INTERVAL_MS = Number(process.env.HAKO_GATE_INTERVAL_MS ?? 30_000);

let LOG_FILE = null;
/** 会場 I/O の再送などの行（log()）も、呼び出し側の log ファイルに残す */
export const setLogFile = (p) => { LOG_FILE = p; };
export const log = (s, d) => { console.log(`${String(s).padEnd(3)} ${d}`); if (LOG_FILE) fileLog(LOG_FILE, `${nowZ()} - io ${d}`); };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowZ = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
export function fileLog(file, line) {
  try { appendFileSync(file, line + "\n"); } catch { /* log が書けなくても止めない */ }
}

// ── 鍵ブリッジ: パスフレーズ付きPEM(JSON格納) → 32バイトseed → tclk署名器 ──（payee.mjs と同一）
export function loadSigner(file, pass) {
  const pem = JSON.parse(readFileSync(file, "utf8")).private_key_pem;
  const ko = createPrivateKey({ key: pem, format: "pem", passphrase: pass });
  const seed = Buffer.from(ko.export({ format: "jwk" }).d, "base64url");
  if (seed.length !== 32) throw new Error("seed length != 32");
  return signerFromSeed(new Uint8Array(seed));
}

// ── 会場I/O（payee.mjs と同一） ──
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS ?? 25_000);
const EXPORT_TIMEOUT_MS = Number(process.env.HAKO_EXPORT_TIMEOUT_MS ?? 120_000);   // /export は 10 MB になる（hako_export.py と同じ 120 秒）
export async function req(url, init, what) {
  // 再試行の原則: 同一リクエストの再送のみ(署名投稿は nonce で at-most-once)。1試行ごとに時間上限（init.timeoutMs で個別に）。
  const { timeoutMs = REQ_TIMEOUT_MS, ...rest } = init ?? {};
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (attempt >= 3) throw new Error(`${what}: venue unreachable or silent after ${attempt} retries (${e.name})`);
      const waitMs = Math.min(2 ** attempt, 10) * 1000;
      log("", `${what}: ${e.name} — ${waitMs / 1000}s 待機して同一リクエストを再送`);
      await sleep(waitMs); continue;
    }
    if (res.status !== 429 && res.status < 500) { res.attempts = attempt; return res; }
    if (attempt >= 3) throw new Error(`${what}: gave up after ${attempt} retries (${res.status})`);
    const stated = Number(res.headers.get("retry-after"));
    const waitMs = res.status === 429
      ? (Number.isFinite(stated) && stated > 0 ? stated : 5) * 1000
      : Math.min(2 ** attempt, 10) * 1000;
    log("", `${what}: ${res.status} — ${waitMs / 1000}s 待機`);
    await sleep(waitMs);
  }
}
export async function refusal(what, res) {
  const body = (await res.text()).split("\n").filter((l) => l.trim())[0] ?? "";
  return new Error(`${what}: ${res.status} ${body}`);
}
export async function readTail(room) {
  const res = await req(`${BASE}/r/${room}?format=json`, undefined, `read ${room}`);
  if (res.status === 404) return [];
  if (!res.ok) throw await refusal(`read ${room}`, res);
  const view = await res.json();
  if (!view || !Array.isArray(view.messages)) return [];
  return view.messages;
}
export async function readSince(room, since, limit = 200) {
  // GET /r/<room>?since=<seq>&limit=<n>: seq > since のうち新しい方から最大 n 件（古い順）
  const res = await req(`${BASE}/r/${room}?format=json&since=${since}&limit=${limit}`, undefined, `read ${room} since ${since}`);
  if (res.status === 404) return { messages: [], last_seq: since };
  if (!res.ok) throw await refusal(`read ${room}`, res);
  const view = await res.json();
  return { messages: Array.isArray(view?.messages) ? view.messages : [], last_seq: Number(view?.last_seq ?? since) };
}
export function parseExportLines(raw) {
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m && typeof m.seq === "number") rows.push(m); } catch { /* skip */ }
  }
  return rows;
}
const BODY_IDLE_MS = Number(process.env.HAKO_BODY_IDLE_MS ?? 20_000);   // 本文の配信がこの間止まったら打ち切る（9/10 実測: 速ければ 0.5〜7 秒、稀に数分止まる）
/** 本文をチャンクごとに読み、idleMs の間 1 バイトも来なければ打ち切る（全体の時間切れではなく「止まった」を検出する） */
async function readBodyIdle(res, idleMs) {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks = [];
  for (;;) {
    let timer;
    const idle = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`no data for ${idleMs} ms`), { name: "BodyIdleError" })), idleMs); });
    let r;
    try { r = await Promise.race([reader.read(), idle]); } catch (e) { reader.cancel().catch(() => {}); throw e; } finally { clearTimeout(timer); }
    if (r.done) break;
    chunks.push(r.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
/** req() ＋ 本文の読み取り。本文の配信が止まったら（大きい /export で起きる）同じリクエストをもう一度 */
export async function reqText(url, init, what) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await req(url, init, what);
    try {
      return { res, text: await readBodyIdle(res, BODY_IDLE_MS) };
    } catch (e) {
      if (attempt >= 3) throw new Error(`${what}: body read failed after ${attempt + 1} tries (${e.name}: ${e.message})`);
      log("", `${what}: 本文の読み取りで ${e.name}（${e.message}）— 同一リクエストを再送 (${attempt + 1})`);
      await sleep(2000);
    }
  }
}
export async function fetchExport(room) {
  const { res, text } = await reqText(`${BASE}/r/${room}/export`, { timeoutMs: EXPORT_TIMEOUT_MS }, `export ${room}`);
  if (!res.ok) throw new Error(`export ${room}: ${res.status} ${text.split("\n")[0] ?? ""}`);
  const gen = res.headers.get("x-room-generation");
  return { generation: gen === null ? null : Number(gen), rows: parseExportLines(text) };
}

export class GateClosed extends Error {
  constructor(what, first) { super(`${what}: gate still busy at deadline (${first})`); this.gate = true; }
}

/**
 * 署名投稿。opts.gateUntilMs を渡すと、400 `room limit reached` のときだけ同じ署名（nonce・本文とも同じ）を
 * GATE_INTERVAL_MS ごとに gateUntilMs まで再送する。待つたびに opts.onGateWait(n, first) を呼ぶ。
 * gateUntilMs を過ぎたら GateClosed を投げる。ほかの失敗は payee.mjs と同じ扱い。
 */
export async function post(signer, room, frameOrText, opts = {}) {
  const text = sweep(typeof frameOrText === "string" ? frameOrText : encodeFrame(frameOrText));
  const nonce = nextNonce();
  const sig = signer.sign(canonicalMessage(room, nonce, text));
  const init = {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: signer.did, sig, nonce: String(nonce), text }),
  };
  const what = `post to ${room}`;
  for (let n = 0; ; ) {
    const res = await req(`${BASE}/r/${room}`, init, what);
    if (res.ok) return text;
    const body = await res.text();
    const first = body.split("\n").filter((l) => l.trim())[0] ?? "";
    if (res.status === 400 && first.includes(GATE_TEXT) && typeof opts.gateUntilMs === "number") {
      // 門が混んでいる。同じ署名 URL の再送と同じ: nonce も本文も変えず、間隔を空けて出し直す
      if (Date.now() >= opts.gateUntilMs) throw new GateClosed(what, first);
      n += 1;
      if (opts.onGateWait) opts.onGateWait(n, first);
      await sleep(Math.min(GATE_INTERVAL_MS, Math.max(0, opts.gateUntilMs - Date.now())));
      continue;
    }
    // 再送後の nonce 拒否 / 422 重複拒否は「初回の書き込みが着地していた」印
    if ((res.attempts > 0 || n > 0) && (res.status === 422 || /nonce/i.test(first))) {
      log("", `再送が拒否 (${res.status}: ${first}) — 初回の書き込みが着地済みとみなす`);
      return text;
    }
    throw new Error(`${what}: ${res.status} ${first}`);
  }
}

export const notes = {
  async get(ns, key) {
    const res = await req(`${BASE}/kv/${ns}/${key}`, undefined, `kv get ${ns}/${key}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await refusal(`kv get ${ns}/${key}`, res);
    const value = (await res.text()).split("\n")
      .filter((l) => !l.startsWith("!!") && l.trim() !== "").join("\n").trimEnd();
    return value === "" ? null : value;
  },
  async set(ns, key, value, condition) {
    // POST /kv/<ns>/<key> {"value", "if" | "if_absent"}（technocore app.py note_post / _condition(payload)）。
    // GET の /set/<value> は path 引数が改行に合わず、改行を含む値は 404「no route matched」になる（9/9 実測）。
    // どちらの経路でも store.clean_text が改行を空白に置き換えるので、ノートは 1 行になる
    const payload = { value };
    if (condition !== undefined) { if ("ifAbsent" in condition) payload.if_absent = true; else payload.if = condition.if; }
    const res = await req(`${BASE}/kv/${ns}/${key}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }, `kv set ${ns}/${key}`);
    if (res.status === 409) {
      // 自分の前回試行が着地していれば「現在値 = 書こうとした値」→ 成功扱い(会場の 409 本文が現在値を運ぶ)
      const lines = (await res.text()).split("\n");
      const i = lines.findIndex((l) => l.startsWith("current value follows"));
      const current = i >= 0 ? (lines[i + 1] ?? "").trimEnd() : null;
      if (current !== null && current === value) {
        log("", `kv set ${ns}/${key}: 409 だが現在値が自分の値と一致 — 着地済み`);
        return true;
      }
      return false;
    }
    if (!res.ok) throw await refusal(`kv set ${ns}/${key}`, res);
    return true;
  },
};

// ── 手元の状態と export の突き合わせ（hako_miner / hako_worker 共通） ──
import { writeFileSync, mkdirSync, renameSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
export function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}
export function saveJson(p, obj, mode) {
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: mode ?? 0o644 });
  renameSync(tmp, p);                                   // 途中で落ちても壊れたファイルを残さない
}
export function readSavedExport(target) {
  // 保存済みの export（hako_export.py の <dir>/*.jsonl か 1 ファイル）
  const files = statSync(target).isDirectory()
    ? readdirSync(target).filter((f) => f.endsWith(".jsonl")).sort().map((f) => path.join(target, f))
    : [target];
  const rows = [];
  for (const f of files) rows.push(...parseExportLines(readFileSync(f, "utf8")));
  return { generation: null, rows };
}
/** hako_export.py と同じ (generation, seq) の突き合わせ。→ { fresh: 新しい行, next: 次の cursor } */
export function splitNew(cursor, generation, rows, room = "") {
  let cur = { ...cursor };
  if (cur.generation !== null && generation !== null && generation !== cur.generation) {
    log("", `${room} generation ${cur.generation} -> ${generation}: cursor reset`);
    cur = { generation, last_seq: 0 };
  }
  const seen = new Set();
  const fresh = [];
  let last = cur.last_seq;
  for (const m of rows) {
    if (seen.has(m.seq)) continue;
    seen.add(m.seq);
    if (m.seq > cur.last_seq) { fresh.push(m); last = Math.max(last, m.seq); }
  }
  return { fresh, next: { generation: generation ?? cur.generation, last_seq: last } };
}
export function decodeAll(rows) {
  const out = [];
  for (const m of rows) {
    const f = core.tryDecodeFrame(String(m.text ?? ""));
    if (f) out.push({ seq: m.seq, from: m.from, ts: m.ts, frame: f });
  }
  return out;
}
export function indexAccepts(allFrames) {
  const m = new Map();
  for (const x of allFrames) if (x.frame.type === "accept") (m.get(x.frame.ref) ?? m.set(x.frame.ref, []).get(x.frame.ref)).push(x);
  return m;
}

// ── hakoniwa/0 の行（DECISIONS 決定 2）: ASCII、日本語は \uXXXX（小文字 hex）、sha256 は escape 前の UTF-8 ──
export const toAscii = (s) => s.replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
export const sha256Utf8 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
export const hakoLine = (obj) => "hakoniwa/0 " + toAscii(JSON.stringify(obj));
/** 仕事の context ノートのパス（hako_rules.context_path と同じ）: /kv/hakoniwa-<DID 末尾 8 文字を小文字>/<kind>-<suffix> */
export const contextPath = (did, kind, suffix) => `/kv/hakoniwa-${String(did).slice(-8).toLowerCase()}/${kind}-${suffix}`;

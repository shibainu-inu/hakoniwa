// hako_worker_web.js — 入口 v2: ブラウザの中で動く worker（ルール v0.7「動き方」の worker の行。hako_worker.mjs の写し）。
// ページを開いている間だけ動き、今日の日記を 1 本閉じる: 運営 client の「あなたの今日の日記を書いて」の offer を受け、
// 自分の数字のノートを置き、miner から推論を買って自分の日記を書き、納品して reveal する。鍵は join ページのもの（外に出ない）。
//
// 読むもの: サイトの latest.json（自分の 5 つの数字、運営 DID）、運営 client のノート /kv/hakoniwa-<client 末尾 8>/open（開いている offer）、
//   掲示板の export（join 済み DID と役。署名は WebCrypto で検証）、取引の部屋（?format=json）、/r/tclk-offers?since=（自分の推論 offer への accept）
// 書くもの: 自分のノート（context と推論の依頼文）、accept / 推論 offer / lock / receipt / diary / reveal（全部 room|nonce|text の署名付き POST）
// 状態: localStorage hako_work_v1（preimage を含む。控えのファイルとは別）
// 限界: 運営のノートは世界中が書き換えられる（technocore のノートはそういうもの）。偽の offer を掴んでも lock が来ないので LOCK_WAIT_MIN で捨てるだけ。
//   /r/tclk-offers は混むので accept の追跡は ?since=&limit=200 の差分（30 秒ごと。200 件を超えると取りこぼしうる。その場合は次の推論 offer で出し直す）
import * as tclk from "./hako_tclk.js";

export const VENUE = "https://technocore.chat";
const BOARD = "hakoniwa-board";
const OFFERS = "tclk-offers";
const STATE_KEY = "hako_work_v1";
const INF_PRICE = "240";                       // ルール v0.7: 運営の miner は 240 以上なら受ける
const INF_EXPIRES_MIN = 120, INF_CLAIMBY_MIN = 240, INF_REFUND_MIN = 360;
const INF_RETRIES = 2;
const LOCK_WAIT_MIN = 20;                      // client の lock を待つ上限（client は 5 分周期。運営 worker を待たせる 30 分より短くてよい: 参加者が先）
const GATE_MS = 30_000;
const TICK_MS = 30_000;
const MAX_CHARS = 140;
const NUM_KEYS = ["earn", "spend", "balance", "mem_bytes", "life_days"];
const FRESH = { earn: 0, spend: 0, balance: 1000, mem_bytes: 0, life_days: null };

// ── 小道具 ──
const enc = new TextEncoder();
const sweep = (s) => s.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu, " ").trim();
const collapse = (s) => s.split(/\s+/).filter(Boolean).join(" ");
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0));
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const ch of s) { const i = ALPHA.indexOf(ch); if (i < 0) throw new Error("base58"); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.push(Number(n & 0xffn)); n >>= 8n; }
  out.reverse();
  let z = 0; for (const ch of s) { if (ch === "1") z += 1; else break; }
  return new Uint8Array([...new Array(z).fill(0), ...out]);
}
export function pubOfDid(did) {
  const raw = b58decode(did.replace(/^did:key:z/, ""));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) throw new Error("not an ed25519 did:key");
  return raw.slice(2);
}
export async function sha256Hex(s) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))); }
const toAscii = (s) => s.replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const hakoLine = (obj) => "hakoniwa/0 " + toAscii(JSON.stringify(obj));
export const contextPath = (did, kind, suffix) => `/kv/hakoniwa-${String(did).slice(-8).toLowerCase()}/${kind}-${suffix}`;
const short = (d) => "…" + String(d).slice(-5);
const iso = (ms) => new Date(ms).toISOString();
const nowZ = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const today8 = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

// ── 会場 I/O ──
async function verifyRow(room, m) {
  try {
    if (typeof m.from !== "string" || !m.from.startsWith("did:key:") || m.sig === undefined || m.nonce === undefined) return false;
    const key = await crypto.subtle.importKey("raw", pubOfDid(m.from), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, unb64u(String(m.sig)), enc.encode(`${room}|${m.nonce}|${collapse(String(m.text))}`));
  } catch { return false; }
}
async function readTail(room) {
  const r = await fetch(`${VENUE}/r/${room}?format=json`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`read ${room}: ${r.status}`);
  const v = await r.json();
  return Array.isArray(v?.messages) ? v.messages : [];
}
async function readSince(room, since, limit = 200) {
  const r = await fetch(`${VENUE}/r/${room}?format=json&since=${since}&limit=${limit}`);
  if (r.status === 404) return { messages: [], last_seq: since };
  if (!r.ok) throw new Error(`read ${room} since: ${r.status}`);
  const v = await r.json();
  return { messages: Array.isArray(v?.messages) ? v.messages : [], last_seq: Number(v?.last_seq ?? since) };
}
export const notes = {
  async get(ns, key) {
    const r = await fetch(`${VENUE}/kv/${ns}/${key}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`kv get ${ns}/${key}: ${r.status}`);
    const v = (await r.text()).split("\n").filter((l) => !l.startsWith("!!") && l.trim() !== "").join("\n").trimEnd();
    return v === "" ? null : v;
  },
  async set(ns, key, value, condition) {
    const payload = { value };
    if (condition !== undefined) { if ("ifAbsent" in condition) payload.if_absent = true; else payload.if = condition.if; }
    const r = await fetch(`${VENUE}/kv/${ns}/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (r.status === 409) {
      const lines = (await r.text()).split("\n");
      const i = lines.findIndex((l) => l.startsWith("current value follows"));
      return i >= 0 && (lines[i + 1] ?? "").trimEnd() === value;   // 自分の前回の書き込みが着地していれば成功扱い
    }
    if (!r.ok) throw new Error(`kv set ${ns}/${key}: ${r.status} ${(await r.text()).split("\n")[0]}`);
    return true;
  },
};
export async function fetchJoins() {
  const r = await fetch(`${VENUE}/r/${BOARD}/export`);
  if (!r.ok) throw new Error(`export ${BOARD}: ${r.status}`);
  const joined = new Map();
  const rows = [];
  for (const line of (await r.text()).split("\n")) { if (!line.trim()) continue; try { const m = JSON.parse(line); if (m && typeof m.seq === "number") rows.push(m); } catch { /* skip */ } }
  for (const m of rows.sort((a, b) => a.seq - b.seq)) {
    if (!(await verifyRow(BOARD, m))) continue;
    const t = String(m.text).trim();
    if (!t.startsWith("hakoniwa/0 ")) continue;
    let f; try { f = JSON.parse(t.slice(11)); } catch { continue; }
    if (!f || f.t !== "join") continue;
    const roles = Array.isArray(f.roles) && f.roles.length ? f.roles.map(String) : ["worker", "client"];
    joined.set(m.from, { roles, lang: typeof f.lang === "string" ? f.lang : "en" });
  }
  return joined;
}

// ── 署名投稿（技術的には join ページと同じ。門: 400 room limit reached だけ同じ署名を 30 秒ごとに再送） ──
let lastNonce = 0;
export function makeSigner(did, priv) {
  return {
    did,
    async post(room, text, opts = {}) {
      const nonce = String(Math.max(Date.now(), lastNonce + 1)); lastNonce = Number(nonce);
      const swept = sweep(text);
      const sig = b64u(new Uint8Array(await crypto.subtle.sign("Ed25519", priv, enc.encode(`${room}|${nonce}|${swept}`))));
      for (let n = 0; ; n++) {
        const r = await fetch(`${VENUE}/r/${room}?format=json`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did, sig, nonce, text: swept }) });
        const body = await r.text();
        if (r.ok) { try { return JSON.parse(body).posted; } catch { return null; } }
        const first = body.split("\n")[0];
        if (r.status === 400 && first.includes("room limit reached") && opts.gateUntilMs && Date.now() < opts.gateUntilMs) {
          opts.onWait?.(n + 1, first); await sleep(GATE_MS); continue;
        }
        const e = new Error(`${r.status} ${first}`); e.gate = first.includes("room limit reached"); throw e;
      }
    },
  };
}

// ── 数字・性格・依頼文・合格条件（hako_rules.py / hako_worker.mjs の写し） ──
export function personalityWords(did, lang) {
  const b = pubOfDid(did);
  const work = (b[2] % 16) - 8, keep = (b[3] % 16) - 8;
  const w = [];
  if (work > 0) w.push(lang === "ja" ? "よく働く" : "hard-working"); else if (work < 0) w.push(lang === "ja" ? "のんびり" : "easygoing");
  if (keep > 0) w.push(lang === "ja" ? "思い出を残したがる" : "keeps memories"); else if (keep < 0) w.push(lang === "ja" ? "忘れっぽい" : "forgetful");
  return w;
}
const numText = (v) => (v === null || v === undefined ? null : (typeof v === "string" ? v : JSON.stringify(v)));
export function buildPrompt(ctx, did) {
  const n = Object.fromEntries(NUM_KEYS.map((k) => [k, numText(ctx[k])]));
  const allowed = NUM_KEYS.map((k) => n[k]).filter((v) => v !== null);
  const words = personalityWords(did, ctx.lang);
  if (ctx.lang === "ja") {
    return ["あなたは HAKONIWA という庭に住む HAKO です。今日の日記を、一人称「私」で書いてください。", "",
      "私の数字（これだけが事実です）:", `- 稼ぎ ${n.earn ?? "0"}`, `- 食費 ${n.spend ?? "0"}`, `- 貯え ${n.balance ?? "0"}`, `- 記憶 ${n.mem_bytes ?? "0"} バイト`,
      n.life_days === null ? "- 余命 数えられない（食費がゼロのため）" : `- 余命 ${n.life_days} 日`,
      ...(words.length ? ["", `私の性格: ${words.join("、")}`] : []), "", "決まり:", "- 1〜2 文、140 文字以内",
      `- 書いてよい数字は上の ${allowed.length} つだけ。回数や日付や時間は数字で書かず、言葉で書く（「一回」「きのう」）`,
      "- 上の数字を変えない。増やさない。丸めない", "- 定型の言い回しを避け、今日の数字から言葉を選ぶ", "- 日記の本文だけを返す。前置き、引用符、説明は付けない"].join("\n");
  }
  return ["You are a HAKO living in a garden called HAKONIWA. Write today's diary entry in the first person.", "",
    "My numbers (these are the only facts):", `- earned ${n.earn ?? "0"}`, `- spent ${n.spend ?? "0"}`, `- savings ${n.balance ?? "0"}`, `- memory ${n.mem_bytes ?? "0"} bytes`,
    n.life_days === null ? "- days left: cannot be counted (spending is zero)" : `- days left: ${n.life_days}`,
    ...(words.length ? ["", `My character: ${words.join(", ")}`] : []), "", "Rules:", "- One or two sentences, 140 characters or fewer",
    `- The only digits you may write are the ${allowed.length} numbers above. Do not write counts, dates, or times as digits; use words`,
    "- Do not change, add to, or round the numbers above", "- Avoid stock phrases; choose words from today's numbers",
    "- Return only the diary text. No preamble, quotation marks, or explanation"].join("\n");
}
const FULLWIDTH = "０１２３４５６７８９";
const halfDigits = (s) => s.replace(/[０-９]/g, (c) => String(FULLWIDTH.indexOf(c)));
/** 合格条件 2〜5（1 は投稿の場所と順で自分が守る）。→ {ok, reason} */
export function checkDiary(text, ctxValues) {
  const fails = [];
  const cps = Array.from(text);
  if (cps.length > MAX_CHARS) fails.push(`3:${cps.length} chars > ${MAX_CHARS}`);
  const allowed = new Set(ctxValues.filter((v) => v !== null && typeof v !== "boolean").map((v) => (typeof v === "string" ? v : JSON.stringify(v))));
  const digits = halfDigits(text).match(/[0-9]+/g) ?? [];
  const bad = [...new Set(digits.filter((d) => !allowed.has(d)))].sort();
  if (bad.length) fails.push("4:numbers not in context: " + bad.join(" "));
  if (!text.trim()) fails.push("5:empty");
  return { ok: fails.length === 0, reason: fails.join("; ") };
}
export function fixNumbers(text, ctxValues) {
  const allowed = new Set(ctxValues.filter((v) => v !== null).map((v) => (typeof v === "string" ? v : JSON.stringify(v))));
  return halfDigits(text).replace(/[0-9]+/g, (d) => (allowed.has(d) ? d : ""));
}

// ── 状態 ──
export function loadState() { try { const s = localStorage.getItem(STATE_KEY); return s ? JSON.parse(s) : null; } catch { return null; } }
export function saveState(st) { localStorage.setItem(STATE_KEY, JSON.stringify(st)); }
export function clearState() { localStorage.removeItem(STATE_KEY); }

// ── 1 周 ──
export class Worker {
  constructor(signer, { statsUrl = "latest.json", onLog = () => {}, onStage = () => {} } = {}) {
    this.me = signer; this.statsUrl = statsUrl; this.onLog = onLog; this.onStage = onStage;
    this.rail = new tclk.PaperRail(notes);
    this.cursor = null;
    this.st = loadState();
  }
  log(stage, msg) { const line = `${nowZ()} ${stage} ${msg}`; this.onLog(line); (this.st?.log ?? (this.st ? (this.st.log = []) : [])).push(line); if (this.st) { this.st.log = this.st.log.slice(-60); saveState(this.st); } }
  set(stage, extra = {}) { Object.assign(this.st, extra, { stage, updated: nowZ() }); saveState(this.st); this.onStage(stage, this.st); }

  async stats() {
    try { const r = await fetch(this.statsUrl, { cache: "no-store" }); return r.ok ? await r.json() : null; } catch { return null; }
  }
  /** 運営 client のノート /kv/hakoniwa-<末尾 8>/open から、開いている日記 offer を集める */
  async openOffers(stats) {
    const ops = Array.isArray(stats?.box?.operators) ? stats.box.operators : [];
    const out = [];
    for (const d of ops) {
      const raw = await notes.get(`hakoniwa-${d.slice(-8).toLowerCase()}`, "open").catch(() => null);
      if (!raw) continue;
      let v; try { v = JSON.parse(raw); } catch { continue; }
      for (const o of v?.open ?? []) {
        const f = o.frame;
        if (!f || f.type !== "offer" || f.from !== d || f.role !== "payer" || f.asset !== "PAPER" || f.lock !== "hash") continue;
        if (!Array.isArray(f.rails) || !f.rails.includes("paper") || !String(f.job?.id ?? "").startsWith("hakoniwa-diary-")) continue;
        // id の照合は tclk の validateFrame と同じ形（frames.ts:314-316）: id だけ外した fields で offerId を計算する。
        // frame をそのまま渡すと id 自身が混ざって必ず不一致になる（2026-09-11 に …JbxX の初試験で「開いている日記 offer が無い」になった原因）
        try { const { id, ...fields } = f; if (tclk.offerId(fields) !== id) continue; } catch { continue; }
        if (Date.now() >= f.expiresMs || Date.now() >= f.claimByMs) continue;
        out.push({ client: d, seq: o.seq, frame: f });
      }
    }
    return out;
  }

  async tick() {
    const me = this.me.did;
    const date8 = today8();
    if (this.st && this.st.date !== date8 && ["done", "gave_up"].includes(this.st.stage)) { this.st = null; }   // 昨日の分は終わり
    if (!this.st) this.st = { date: date8, stage: "idle", log: [] };
    const st = this.st;
    try {
      if (st.stage === "idle" || st.stage === "no_lock") {
        // 2〜3. 開いている offer を 1 つ受ける（自分の数字のノートを先に置く）
        const stats = await this.stats();
        const joined = await fetchJoins();
        if (!joined.has(me)) { this.log("join", "この DID は掲示板に join していない"); return; }
        if ((stats?.did?.[me]?.state ?? "seated") !== "seated") { this.log("seat", `席にいない (${stats.did[me].state})`); this.set("gave_up"); return; }
        const tried = new Set(st.tried ?? []);
        const cands = (await this.openOffers(stats)).filter((o) => !tried.has(o.frame.id) && o.frame.from !== me);
        if (!cands.length) { this.log("offer", "開いている日記 offer が無い（client は 5 分ごとに出す）"); return; }
        const pick = cands[0];
        const d = stats?.did?.[me];
        const src = d ?? FRESH;
        const int = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));
        const e = joined.get(me);
        const note = { did: me, date: `${date8.slice(0, 4)}-${date8.slice(4, 6)}-${date8.slice(6, 8)}`, lang: e?.lang ?? "en", roles: e?.roles ?? [],
          earn: int(src.earn), spend: int(src.spend), balance: int(src.balance), mem_bytes: int(src.mem_bytes), life_days: int(src.life_days) };
        const notePath = contextPath(me, "diary", date8);
        const [, ns, key] = notePath.match(/^\/kv\/([^/]+)\/([^/]+)$/);
        if (!(await notes.set(ns, key, JSON.stringify(note)))) { this.log("note", `ノートを書けない ${notePath}`); return; }
        this.log("note", `ok ${notePath} ${NUM_KEYS.map((k) => `${k}=${note[k]}`).join(",")}${d ? "" : " (fresh)"}`);
        const hl = tclk.generateHashLock();
        const core = { from: me, ref: pick.frame.id, statement: hl.hash, nonce: randomHex(8) };
        const accept = { type: "accept", ...core, contract: tclk.contractId(pick.frame, core) };
        const text = tclk.encodeFrame(accept);
        this.set("accepting", { offer: pick.frame, client: pick.client, job: pick.frame.job.id, ctx: note, note: notePath, accept, accept_text: text,
          contract: accept.contract, room: tclk.dealRoom(accept.contract), preimage: hl.preimage, statement: hl.hash, accepted_at_ms: Date.now(),
          claimByMs: pick.frame.claimByMs, refundAfterMs: pick.frame.refundAfterMs, tried: [...tried, pick.frame.id], inf: null });
        await this.me.post(OFFERS, text, { gateUntilMs: pick.frame.claimByMs, onWait: (n) => this.log("accept", `gate busy, retry ${n}`) });
        this.set("accepted");
        this.log("accept", `ok ${st.job} amount=${pick.frame.amount} client=${short(pick.client)} contract ${st.contract.slice(0, 18)}`);
        return;
      }
      if (st.stage === "accepting") { this.set("accepted"); return; }   // 着地不明: 部屋の lock を待つ側へ（来なければ LOCK_WAIT_MIN で捨てる）
      if (st.stage === "accepted") {
        // 4. client の lock
        const msgs = await readTail(st.room);
        const lock = msgs.map((m) => ({ m, f: tclk.tryDecodeFrame(String(m.text ?? "")) })).find((x) => x.f && x.f.type === "lock" && x.f.contract === st.contract && x.f.rail === "paper" && x.m.from === st.client)?.f;
        if (!lock) {
          if (Date.now() - st.accepted_at_ms > LOCK_WAIT_MIN * 60_000) { this.log("lock", `${LOCK_WAIT_MIN} 分たっても lock が来ない。別の offer を探す`); this.set("no_lock"); }
          return;
        }
        const stepA = tclk.applyFrame(tclk.openContract(st.offer), st.accept, st.accepted_at_ms);
        if (!stepA.ok) { this.log("lock", `契約の状態を組めない: ${stepA.reason}`); return; }
        const held = await this.rail.verifyLock(tclk.lockTerms(stepA.state), lock.ref).catch(() => false);
        if (!held) { this.log("lock", "部屋に lock はあるが rail の記録が合わない。次の周に再確認"); return; }
        this.set("locked", { lock_ref: lock.ref });
        this.log("lock", `ok ref=${lock.ref.slice(0, 18)}`);
      }
      if (st.stage === "locked") {
        // 5. 依頼文 → 自分の推論ノート → 推論 offer
        const n = (st.inf_tries ?? 0) + 1;
        if (n > INF_RETRIES + 1) { this.set("gave_up"); this.log("inf-offer", `${n - 1} 回出しても miner が付かない。今日はあきらめる`); return; }
        const prompt = collapse(buildPrompt(st.ctx, me));
        const notePath = contextPath(me, "inf", `${st.contract.slice(2, 10)}-${n}`);
        const [, ns, key] = notePath.match(/^\/kv\/([^/]+)\/([^/]+)$/);
        if (!(await notes.set(ns, key, prompt))) { this.log("inf-offer", `ノートを書けない ${notePath}`); return; }
        const t = Date.now();
        const cap = (min) => Math.min(t + min * 60_000, st.claimByMs);
        const claimBy = cap(INF_CLAIMBY_MIN);
        const infOffer = tclk.makeOffer({ from: me, role: "payer", lock: "hash", amount: INF_PRICE, asset: "PAPER", rails: ["paper"],
          expiresMs: Math.min(cap(INF_EXPIRES_MIN), claimBy - 60_000), claimByMs: claimBy, refundAfterMs: Math.max(claimBy + 60_000, cap(INF_REFUND_MIN)),
          job: { proto: "hakoniwa", id: `hakoniwa-inf-${st.contract.slice(2, 10)}${st.job.includes("-test-") ? "-test" : ""}-${n}`, context: notePath } });
        this.set("inf_offering", { inf_tries: n, inf: { offer: infOffer, note: notePath, job: infOffer.job.id } });
        const posted = await this.me.post(OFFERS, tclk.encodeFrame(infOffer), { gateUntilMs: st.claimByMs, onWait: (k) => this.log("inf-offer", `gate busy, retry ${k}`) });
        this.cursor = posted?.seq ?? null;
        this.set("inf_offered", { inf: { ...st.inf, seq: posted?.seq ?? null } });
        this.log("inf-offer", `ok ${infOffer.job.id} amount=${INF_PRICE} expires=${iso(infOffer.expiresMs)}`);
        return;
      }
      if (st.stage === "inf_offering") { this.set("locked"); return; }   // 着地不明: 通し番号を進めて出し直す
      if (st.stage === "inf_offered") {
        // 6. miner の accept（join 済み・miner 役・自分以外・contract 一致・seq 最初）を lock
        const infOffer = st.inf.offer;
        const since = this.cursor ?? st.inf.seq ?? 0;
        const { messages } = await readSince(OFFERS, Math.max(0, since - 1));
        if (messages.length >= 200) this.log("inf-accept", "差分が 200 件を超えた（取りこぼしの可能性）");
        const accs = [];
        for (const m of messages) {
          const f = tclk.tryDecodeFrame(String(m.text ?? ""));
          if (f && f.type === "accept" && f.ref === infOffer.id) accs.push({ m, f });
        }
        const joined = accs.length ? await fetchJoins() : new Map();
        let chosen = null; const why = [];
        for (const { m, f } of accs.sort((a, b) => a.m.seq - b.m.seq)) {
          const e = joined.get(m.from); const reasons = [];
          if (!e) reasons.push("join していない"); else if (!e.roles.includes("miner")) reasons.push("役に miner が無い");
          if (m.from === me || m.from !== f.from) reasons.push("自分か署名者違い");
          let expect = null; try { expect = tclk.contractId(infOffer, { from: f.from, ref: f.ref, statement: f.statement, paymentKey: f.paymentKey, nonce: f.nonce }); } catch { /* bad */ }
          if (expect !== f.contract) reasons.push("contract id 不一致");
          why.push(`seq ${m.seq} ${short(m.from)}: ${reasons.length ? reasons.join(", ") : "採用"}`);
          if (!reasons.length) { chosen = { m, f }; break; }
        }
        if (!chosen) {
          if (why.length) this.log("inf-accept", why.join(" | "));
          if (Date.now() >= infOffer.expiresMs) { this.log("inf-accept", "expiresMs までに受けられる accept が無い。出し直す"); this.set("locked"); }
          return;
        }
        const infContract = chosen.f.contract, infRoom = tclk.dealRoom(infContract);
        const stepA = tclk.applyFrame(tclk.openContract(infOffer), chosen.f, Date.parse(chosen.m.ts));
        if (!stepA.ok) { this.log("inf-accept", `accept を適用できない: ${stepA.reason}`); return; }
        let ref;
        const existing = await this.rail.read(infContract).catch(() => null);
        if (existing && existing.statement === chosen.f.statement) ref = infContract; else ref = await this.rail.lock(tclk.lockTerms(stepA.state));
        const lockFrame = { type: "lock", from: me, contract: infContract, rail: "paper", ref };
        this.set("inf_locking", { inf: { ...st.inf, contract: infContract, room: infRoom, miner: chosen.m.from, accept: chosen.f, accepted_at_ms: Date.parse(chosen.m.ts), lock: lockFrame } });
        this.log("inf-accept", `chose ${short(chosen.m.from)} seq ${chosen.m.seq} (${why.join(" | ")})`);
        try {
          await this.me.post(infRoom, tclk.encodeFrame(lockFrame), { gateUntilMs: infOffer.claimByMs, onWait: (k) => this.log("inf-lock", `gate busy, retry ${k}`) });
        } catch (e) { if (e.gate) { this.set("gave_up"); this.log("inf-lock", "門が claimByMs まで開かなかった"); return; } throw e; }
        this.set("inf_locked");
        this.log("inf-lock", `ok room ${infRoom}`);
        try { const sn = tclk.stateNote(infContract); await notes.set(sn.ns, sn.key, tclk.stateNoteValue("locked", ref), { if: tclk.stateNoteValue("accepted") }); } catch { /* 参考情報 */ }
        return;
      }
      if (st.stage === "inf_locking") {
        const msgs = await readTail(st.inf.room).catch(() => []);
        const landed = msgs.some((m) => m.from === me && tclk.tryDecodeFrame(String(m.text ?? ""))?.type === "lock");
        this.set(landed ? "inf_locked" : "inf_offered"); this.log("inf-lock", landed ? "landed" : "not landed; lock again"); return;
      }
      if (st.stage === "inf_locked") {
        // 7. miner の inf と reveal → receipt
        const infOffer = st.inf.offer, infContract = st.inf.contract;
        const msgs = await readTail(st.inf.room);
        let inf = null, reveal = null;
        for (const m of msgs) {
          const text = String(m.text ?? "");
          if (m.from !== st.inf.miner) continue;
          if (inf === null && text.startsWith("hakoniwa/0 ")) { try { const h = JSON.parse(text.slice(11)); if (h.t === "inf" && h.contract === infContract) inf = h; } catch { /* skip */ } }
          const f = tclk.tryDecodeFrame(text);
          if (f && f.type === "reveal" && f.contract === infContract) reveal = f;
        }
        if (reveal === null || inf === null) {
          if (Date.now() >= infOffer.refundAfterMs) {
            await this.me.post(st.inf.room, tclk.encodeFrame({ type: "refund", from: me, contract: infContract, ref: st.inf.lock.ref }), { gateUntilMs: st.claimByMs });
            this.log("inf-refund", `refundAfterMs までに inf/reveal が無い。refund して出し直す`); this.set("locked");
          }
          return;
        }
        const view = tclk.applyFrame(tclk.openContract(infOffer), st.inf.accept, st.inf.accepted_at_ms).state;
        const stepL = tclk.applyFrame(view, st.inf.lock, st.inf.accepted_at_ms + 1);
        const stepR = stepL.ok ? tclk.applyFrame(stepL.state, reveal, Date.now()) : stepL;
        if (!stepR.ok || stepR.state.status !== "claimed") { this.log("inf-receipt", `reveal を適用できない: ${stepR.reason}`); return; }
        if (typeof inf.text !== "string" || (await sha256Hex(inf.text)) !== inf.sha256) { this.set("gave_up"); this.log("inf-receipt", "inf の sha256 が本文と合わない。receipt しない"); return; }
        await this.me.post(st.inf.room, tclk.encodeFrame({ type: "receipt", from: me, contract: infContract, outcome: "claimed", rail: "paper", ref: st.inf.lock.ref }), { gateUntilMs: st.claimByMs });
        this.set("inf_done", { inf: { ...st.inf, text: inf.text, model: inf.model ?? null } });
        this.log("inf-receipt", `ok model=${inf.model} ${Array.from(inf.text).length} chars`);
      }
      if (st.stage === "inf_done") {
        // 8. 本文を確かめて diary を納品（for は自分）
        const ctxValues = NUM_KEYS.map((k) => (st.ctx[k] === undefined ? null : st.ctx[k]));
        let text = String(st.inf.text).trim();
        let r = checkDiary(text, ctxValues);
        if (!r.ok) {
          const fixed = Array.from(fixNumbers(text, ctxValues).trim()).slice(0, MAX_CHARS).join("").trim();
          const r2 = checkDiary(fixed, ctxValues);
          this.log("diary-check", `first: ${r.reason} → after fixing numbers: ${r2.ok ? "ok" : r2.reason}`);
          if (!r2.ok) { this.set("gave_up"); this.log("diary", "本文が合格条件を通らない。納品しない"); return; }
          text = fixed;
        }
        const date = `${st.date.slice(0, 4)}-${st.date.slice(4, 6)}-${st.date.slice(6, 8)}`;
        const diary = { t: "diary", contract: st.contract, for: me, date, text, sha256: await sha256Hex(text), model: st.inf.model ?? "unknown", nonce: randomHex(8) };
        this.set("delivering", { diary });
        await this.me.post(st.room, hakoLine(diary), { gateUntilMs: st.claimByMs, onWait: (k) => this.log("diary", `gate busy, retry ${k}`) });
        this.set("delivered");
        this.log("diary", `ok ${Array.from(text).length} chars: ${text}`);
      }
      if (st.stage === "delivering") {
        const msgs = await readTail(st.room).catch(() => []);
        const landed = msgs.some((m) => m.from === me && String(m.text ?? "").includes(`"sha256":"${st.diary.sha256}"`));
        this.set(landed ? "delivered" : "inf_done"); this.log("diary", landed ? "landed" : "not landed; deliver again");
        if (!landed) return;
      }
      if (st.stage === "delivered") {
        // reveal（locked の間、refundAfterMs 前、ref は client の lock.ref）
        if (Date.now() >= st.refundAfterMs) { this.set("gave_up"); this.log("reveal", "refundAfterMs を過ぎた"); return; }
        await this.me.post(st.room, tclk.encodeFrame({ type: "reveal", from: me, contract: st.contract, ref: st.lock_ref, secret: st.preimage }), { gateUntilMs: st.claimByMs });
        this.set("done");
        this.log("reveal", "ok。あとは client の receipt（5 分ごと）。数字は次の fold（毎時 10 分 UTC）で動く");
        try { await this.rail.claim(st.lock_ref, st.preimage); } catch { /* 参考情報 */ }
        try { const sn = tclk.stateNote(st.contract); await notes.set(sn.ns, sn.key, tclk.stateNoteValue("claimed", st.lock_ref), { if: tclk.stateNoteValue("locked", st.lock_ref) }); } catch { /* 参考情報 */ }
      }
    } catch (e) {
      this.log(st.stage, `error ${e.message}`);
    }
  }

  /** ページを開いている間、TICK_MS ごとに回す。stop() で止まる */
  async run() {
    this.running = true;
    while (this.running) {
      await this.tick();
      if (this.st && ["done", "gave_up"].includes(this.st.stage)) break;
      for (let i = 0; i < TICK_MS / 1000 && this.running; i++) await sleep(1000);
    }
    this.running = false;
  }
  stop() { this.running = false; }
}

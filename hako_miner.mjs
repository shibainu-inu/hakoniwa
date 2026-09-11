#!/usr/bin/env node
// hako_miner.mjs — 箱庭の miner。hakoniwa-inf- の offer を受け、Ollama で推論し、inf を納品して reveal する。
// 土台: ~/technocore-inference-market/tclk/payee.mjs（req / post / notes / loadSigner はそのまま。hako_common.mjs に切り出した）。
// 投稿が 400 `room limit reached`（部屋の総数上限 = 門）なら、同じ署名を 30 秒ごとにその契約の claimByMs まで再送する（hako_common.post）。
// 用法: read -s TC_PASS && export TC_PASS   # パスフレーズは端末に打つ。コマンド行に書かない
//       node hako_miner.mjs            # 30 分ごとのループ
//       node hako_miner.mjs --dry-run [--export <dir|file>]   # 候補の抽出だけ（保存済み export を読む。鍵は要らない）
//       node hako_miner.mjs --once      # 1 周だけ
// 環境変数: KEY_PATH (既定 ~/did_miner.json), TCLK_DIR (既定 ~/tclk), TECHNOCORE_URL,
//   HAKO_MINER_INTERVAL_SEC (既定 300 = 5 分。ルール v0.7「動き方」), HAKO_MINER_MIN (既定 240 = ルール v0.7 の運営 miner の下限), HAKO_OLLAMA_MODEL (既定 qwen2.5:1.5b),
//   OLLAMA_URL (既定 http://localhost:11434), HAKO_MINER_STATE (既定 ~/.hako_miner), HAKO_MINER_LOG (既定 ~/hako_miner.log)
//
// miner は自分から offer を出さず、部屋も作らない（lock を出す払う側が作る）。
// 1 周ですること:
//   1. /r/tclk-offers/export を丸ごと取り、(generation, seq) で新しい行だけを候補にする（cursor は state/cursor.json）。
//      30 分でリングが一周しない前提は 9/9 の実測（約 55 分）に基づく
//   2. 候補: type offer / role payer / asset PAPER / rails に paper / lock hash / job.id が hakoniwa-inf- /
//      amount ≥ HAKO_MINER_MIN / expiresMs 未到来 / claimByMs 未到来 / 自分の offer ではない /
//      「庭に join 済みの DID」の accept が先に無い（決定 12: 庭の外の bot の accept は無視する。join 済みかは /r/hakoniwa-board の
//      export で判定し、周ごとに 1 回読む。hako_board.mjs）
//   3. accept（hash lock、statement は自分の preimage の sha256）。contract は tclk の contractId(生の offer, accept core)。
//      accept と preimage は state/deals.json（0600）に投稿前に残す。再起動しても同じ offer に二度 accept しない
//   4. accept 済みの契約ごとに派生ルーム（dealRoom）を読み、払う側の lock を待つ。claimByMs を過ぎても無ければ諦める
//   5. lock を確認したら offer.job.context のノートを読み、中身をそのまま Ollama に渡す
//   6. inf の行（hakoniwa/0、ASCII、sha256 は escape 前の UTF-8）を派生ルームに納品する
//   7. reveal（preimage）。receipt は払う側の仕事なので待たない
//   8. 1 件ごとに log に 1 行（時刻、contract 先頭 16、段階、結果）
// tclk の順序とフレームは ~/tclk (5cc4ab9) SPEC.md §3.2〜3.4 と §4 のとおり: lock は払う側が refundAfterMs 前、reveal は受け取り側が
// locked の間に refundAfterMs 前（ref は lock.ref と同じ）。claimByMs を過ぎた reveal は「遅い」が許される。
// 同じ本文を 120 秒に 5 回出さない: 1 周で同じ本文は 1 回しか出さず、再送は次の周（周期ぶん空く）。
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fetchJoins, parseJoins, parseExportLines as parseBoardLines } from "./hako_board.mjs";
import { BOX, BOARD_ROOM, OFFER_ROOM, jobPrefix } from "./hako_box.mjs";
import { core, BASE, log, sleep, nowZ, setLogFile, loadSigner, req, readTail, post, notes, refusal, fetchExport } from "./hako_common.mjs";

const {
  PaperRail, applyFrame, canonicalJson, contractId, dealRoom, encodeFrame, generateHashLock,
  lockTerms, openContract, stateNote, stateNoteValue, tryDecodeFrame,
} = core;

const KEY_PATH = process.env.KEY_PATH ?? path.join(homedir(), "did_miner.json");
const INTERVAL_SEC = Number(process.env.HAKO_MINER_INTERVAL_SEC ?? BOX.miner_interval_sec);   // 数字と名前の既定は hako_box.json（決定 16）。env で上書き
const MIN_AMOUNT = Number(process.env.HAKO_MINER_MIN ?? BOX.inference_min);
const MODEL = process.env.HAKO_OLLAMA_MODEL ?? "qwen2.5:1.5b";
const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const STATE_DIR = process.env.HAKO_MINER_STATE ?? path.join(homedir(), ".hako_miner");
const LOG_PATH = process.env.HAKO_MINER_LOG ?? path.join(homedir(), "hako_miner.log");
const JOB_PREFIX = jobPrefix("inf");
const MAX_CHARS = 140;               // HAKONIWA-RULES「行の形」: text は 140 字以内
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const ONCE = argv.includes("--once");
const EXPORT_ARG = argv.includes("--export") ? argv[argv.indexOf("--export") + 1] : null;

function jlog(contract, stage, result) {
  // 1 件 1 行: 時刻、contract 先頭 16、段階、結果。DID は log 以外に書かない
  const line = `${nowZ()} ${String(contract).slice(0, 16)} ${stage} ${result}`;
  console.log(line);
  try { appendFileSync(LOG_PATH, line + "\n"); } catch { /* log が書けなくても止めない */ }
}

// ── 手元の状態（cursor.json / deals.json） ──
function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}
function saveJson(p, obj, mode) {
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: mode ?? 0o644 });
  renameSync(tmp, p);                                   // 途中で落ちても壊れたファイルを残さない
}
const CURSOR_PATH = path.join(STATE_DIR, "cursor.json");
const DEALS_PATH = path.join(STATE_DIR, "deals.json");
const loadCursor = () => readJson(CURSOR_PATH, { generation: null, last_seq: 0 });
const loadDeals = () => readJson(DEALS_PATH, {});
const saveDeals = (deals) => saveJson(DEALS_PATH, deals, 0o600);
function mark(deals, contract, stage, extra) {
  Object.assign(deals[contract], extra ?? {}, { stage, updated: nowZ() });
  saveDeals(deals);
}

// ── export の読み取り（hako_export.py と同じ (generation, seq) の突き合わせ） ──
function parseExportLines(raw) {
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m && typeof m.seq === "number") rows.push(m); } catch { /* skip */ }
  }
  return rows;
}
const fetchOffersExport = () => fetchExport(OFFER_ROOM);
function readSavedExport(target) {
  // --dry-run: 保存済みの export（hako_export.py の <dir>/*.jsonl か 1 ファイル）
  const files = statSync(target).isDirectory()
    ? readdirSync(target).filter((f) => f.endsWith(".jsonl")).sort().map((f) => path.join(target, f))
    : [target];
  const rows = [];
  for (const f of files) rows.push(...parseExportLines(readFileSync(f, "utf8")));
  return { generation: null, rows };
}
function splitNew(cursor, generation, rows) {
  let cur = { ...cursor };
  if (cur.generation !== null && generation !== null && generation !== cur.generation) {
    log("", `${OFFER_ROOM} generation ${cur.generation} -> ${generation}: cursor reset`);
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

// ── 候補の抽出 ──
function decodeAll(rows) {
  const out = [];
  for (const m of rows) {
    const f = tryDecodeFrame(String(m.text ?? ""));
    if (f) out.push({ seq: m.seq, from: m.from, ts: m.ts, frame: f });
  }
  return out;
}
// 候補条件を 1 つずつ当てる → [{cond, ok, actual}]。落ちた条件は実際の値と一緒に残す
function judge(f, { acceptsByRef, myDid, mine, now, joined }) {
  const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : String(ms));
  const accs = acceptsByRef.get(f.id) ?? [];
  const short = (did) => "…" + String(did).slice(-5);
  const isJoined = (did) => joined.has(did);
  const accText = (a) => `seq ${a.seq} ${a.ts} from ${short(a.from)}${isJoined(a.from) ? " (join 済み)" : " (庭の外)"}`;
  return [
    { cond: "type offer", ok: f.type === "offer", actual: f.type },
    { cond: "role payer", ok: f.role === "payer", actual: f.role },
    { cond: "asset PAPER", ok: f.asset === "PAPER", actual: f.asset },
    { cond: "rails に paper", ok: Array.isArray(f.rails) && f.rails.includes("paper"), actual: JSON.stringify(f.rails) },
    { cond: "lock hash", ok: f.lock === "hash", actual: f.lock },
    { cond: `job.id が ${JOB_PREFIX}`, ok: !!f.job && typeof f.job.id === "string" && f.job.id.startsWith(JOB_PREFIX), actual: f.job?.id },
    { cond: `amount ≥ ${MIN_AMOUNT}`, ok: /^[1-9][0-9]*$/.test(String(f.amount)) && Number(f.amount) >= MIN_AMOUNT, actual: f.amount },
    { cond: "expiresMs 未到来", ok: typeof f.expiresMs === "number" && now < f.expiresMs, actual: `${iso(f.expiresMs)} (now ${iso(now)})` },
    { cond: "claimByMs 未到来", ok: typeof f.claimByMs === "number" && now < f.claimByMs, actual: iso(f.claimByMs) },
    { cond: "join 済み DID の accept が先に無い", ok: !accs.some((a) => isJoined(a.from)),
      actual: accs.length === 0 ? "none" : accs.map(accText).join("; ") },
    { cond: "自分の offer ではない", ok: myDid === null || f.from !== myDid, actual: myDid === null ? "(鍵なし: 判定省略)" : short(f.from) },
    { cond: "自分がまだ accept していない", ok: !mine.has(f.id), actual: mine.has(f.id) ? "deals.json にある" : "none" },
  ];
}
function indexAccepts(allFrames) {
  const m = new Map();
  for (const x of allFrames) if (x.frame.type === "accept") (m.get(x.frame.ref) ?? m.set(x.frame.ref, []).get(x.frame.ref)).push(x);
  return m;
}
function candidates(allFrames, freshFrames, myDid, deals, now, joined, onSkip) {
  const ctx = { acceptsByRef: indexAccepts(allFrames), myDid, mine: new Set(Object.values(deals).map((d) => d.offer_id)), now, joined };
  const out = [];
  for (const { seq, frame: f } of freshFrames) {
    if (f.type !== "offer") continue;
    const checks = judge(f, ctx);
    const fails = checks.filter((c) => !c.ok);
    if (fails.length === 0) { out.push({ seq, offer: f }); continue; }
    // hakoniwa-inf- の offer を見送ったときだけ、落ちた条件と実際の値を残す（それ以外の offer は多すぎるので出さない）
    if (onSkip && f.job && typeof f.job.id === "string" && f.job.id.startsWith(JOB_PREFIX)) onSkip(seq, f, fails);
  }
  return out;
}
const failText = (fails) => fails.map((c) => `${c.cond}: ${c.actual}`).join(" | ");

// ── Ollama の疎通（accept の前に確かめる。届かなければ黙って見送らず log に残す） ──
async function ollamaReady() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return `HTTP ${res.status}`;
    const j = await res.json();
    const names = (j.models ?? []).map((m) => m.name);
    return names.includes(MODEL) ? null : `model ${MODEL} not in [${names.join(", ")}]`;
  } catch (e) { return `${e.name}: ${e.message}`; }
}

// ── inf の行（DECISIONS 決定 2）: ASCII、日本語は \uXXXX（小文字 hex）、sha256 は escape 前の UTF-8 ──
const toAscii = (s) => s.replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const sha256Utf8 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
function infLine(contract, text, model) {
  const body = { t: "inf", contract, text, sha256: sha256Utf8(text), model, nonce: randomBytes(8).toString("hex") };
  return "hakoniwa/0 " + toAscii(JSON.stringify(body));
}

// ── Ollama ──
async function infer(prompt) {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false }),
    signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS ?? 600_000)),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const j = await res.json();
  return String(j.response ?? "");
}

// ── 1 周 ──
async function step(me) {
  const deals = loadDeals();
  const now = Date.now();
  const rail = new PaperRail(notes);

  // 1〜3. 新しい offer を候補にして accept
  const cursor = loadCursor();
  const exp = await fetchOffersExport();
  const { fresh, next } = splitNew(cursor, exp.generation, exp.rows);
  const allFrames = decodeAll(exp.rows);
  const freshFrames = decodeAll(fresh);
  const infOffers = freshFrames.filter((x) => x.frame.type === "offer" && String(x.frame.job?.id ?? "").startsWith(JOB_PREFIX)).length;
  const board = await fetchJoins(BASE, req);              // 庭に join 済みの DID（周ごとに 1 回。署名検証つき）
  const found = candidates(allFrames, freshFrames, me.did, deals, now, board.joined,
    (seq, f, fails) => jlog(f.id, "skip", `seq ${seq} job=${f.job.id} amount=${f.amount} — ${failText(fails)}`));
  jlog("-", "round", `gen ${exp.generation} rows ${exp.rows.length} new ${fresh.length} last_seq ${next.last_seq} ${JOB_PREFIX}* offers ${infOffers} candidates ${found.length} joined ${board.joined.size} (board bad_sig ${board.stats.bad_sig})`);
  const ollamaDown = found.length > 0 ? await ollamaReady() : null;
  if (ollamaDown !== null) {
    jlog("-", "ollama", `Ollama に届かないので見送り (${OLLAMA}: ${ollamaDown}) — 候補 ${found.length} 件は accept しない。cursor は進めず次の周で見直す`);
    found.length = 0;
  }
  for (const { offer } of found) {
    const hl = generateHashLock();
    const acceptCore = { from: me.did, ref: offer.id, statement: hl.hash, nonce: randomBytes(8).toString("hex") };
    const accept = { type: "accept", ...acceptCore, contract: contractId(offer, acceptCore) };
    // 本文: encodeFrame が accept を通せばそれ、通らなければ contractId と同じ canonicalJson（probe_accept.mjs と同じ）
    let text;
    try { text = encodeFrame(accept); } catch { text = "tclk1 " + canonicalJson(accept); }
    const contract = accept.contract;
    deals[contract] = {
      offer_id: offer.id, job: offer.job.id, amount: offer.amount, payer: offer.from, context: offer.job.context ?? null,
      claimByMs: offer.claimByMs, refundAfterMs: offer.refundAfterMs, offer, accept_text: text,
      statement: hl.hash, preimage: hl.preimage, room: dealRoom(contract), stage: "accepting", updated: nowZ(),
      accepted_at_ms: Date.now(),                       // 契約の状態を組み直すときに accept を当てる時刻（offer の失効前）
    };
    saveDeals(deals);                                   // 投稿の前に残す（落ちても二重に accept しない）
    try {
      await post(me, OFFER_ROOM, text, { gateUntilMs: offer.claimByMs, onGateWait: (n) => jlog(contract, "accept", `gate busy, retry ${n}`) });
      mark(deals, contract, "accepted");
      jlog(contract, "accept", `ok job=${offer.job.id} amount=${offer.amount}`);
      try { const sn = stateNote(contract); await notes.set(sn.ns, sn.key, stateNoteValue("accepted"), { ifAbsent: true }); }
      catch (e) { jlog(contract, "state-note", `skip ${e.message}`); }
    } catch (e) {
      jlog(contract, "accept", `fail ${e.message}`);    // stage は accepting のまま。次の周で export を見て判断する
    }
  }
  if (ollamaDown === null) saveJson(CURSOR_PATH, next);

  // 3'. accepting のまま残った契約: export に自分の accept があれば accepted、無ければ出し直す（前の周から周期ぶん空いている）
  for (const [contract, d] of Object.entries(deals)) {
    if (d.stage !== "accepting") continue;
    const landed = allFrames.some((x) => x.frame.type === "accept" && x.frame.contract === contract && x.from === me.did);
    if (landed) { mark(deals, contract, "accepted"); jlog(contract, "accept", "landed (seen in export)"); continue; }
    if (Date.now() >= d.offer.expiresMs) { mark(deals, contract, "expired"); jlog(contract, "accept", "gave up: offer expired"); continue; }
    try { await post(me, OFFER_ROOM, d.accept_text, { gateUntilMs: d.claimByMs, onGateWait: (n) => jlog(contract, "accept", `gate busy, retry ${n}`) }); mark(deals, contract, "accepted"); jlog(contract, "accept", "ok (re-sent)"); }
    catch (e) { jlog(contract, "accept", `fail (re-send) ${e.message}`); }
  }

  // 4〜7. accept 済みの契約: lock を待ち、推論して inf を納品し、reveal
  for (const [contract, d] of Object.entries(deals)) {
    if (!["accepted", "locked", "delivered"].includes(d.stage)) continue;
    try {
      if (d.stage === "accepted") {
        const msgs = await readTail(d.room);
        let lock = null;
        for (const m of msgs) {
          const f = tryDecodeFrame(String(m.text ?? ""));
          if (f && f.type === "lock" && f.contract === contract && f.rail === "paper" && m.from === d.payer) { lock = f; break; }
        }
        if (lock === null) {
          if (Date.now() > d.claimByMs) { mark(deals, contract, "no_lock"); jlog(contract, "lock", "gave up: claimByMs passed without lock"); }
          continue;
        }
        // レール自体を検証（payee.mjs と同じ。相手の言葉は信じない）。契約の状態は、出した accept そのもの（deals.json の accept_text）を
        // 出したときの時刻で当てて組み直す。「今」で当てると offer 失効後に machine.ts:120 (offer has expired) で拒否される
        const acceptFrame = tryDecodeFrame(d.accept_text);
        const acceptedAt = typeof d.accepted_at_ms === "number" ? d.accepted_at_ms : Math.min(Date.now(), d.offer.expiresMs - 1);
        const stepA = applyFrame(openContract(d.offer), acceptFrame, acceptedAt);
        if (!stepA.ok) { jlog(contract, "lock", `cannot rebuild contract state: ${stepA.reason}; retry next round`); continue; }
        const held = await rail.verifyLock(lockTerms(stepA.state), lock.ref).catch(() => false);
        if (!held) { jlog(contract, "lock", `seen but rail record does not match (ref=${lock.ref.slice(0, 18)}); retry next round`); continue; }
        mark(deals, contract, "locked", { lock_ref: lock.ref });
        jlog(contract, "lock", `ok ref=${lock.ref.slice(0, 18)}`);
      }
      if (d.stage === "locked") {
        if (Date.now() >= d.refundAfterMs) { mark(deals, contract, "late"); jlog(contract, "inf", "gave up: refundAfterMs passed"); continue; }
        // 5. context ノート（中身は worker の依頼文。見ずにそのまま渡す）
        const m = typeof d.context === "string" ? d.context.match(/^\/kv\/([^/]+)\/([^/]+)$/) : null;
        if (!m) { mark(deals, contract, "no_context"); jlog(contract, "context", `gave up: job.context is not /kv/<ns>/<key> (${d.context})`); continue; }
        const prompt = await notes.get(m[1], m[2]);
        if (prompt === null) { jlog(contract, "context", "note not found; retry next round"); continue; }
        // 5'. 推論
        const t0 = Date.now();
        let text = (await infer(prompt)).trim();
        if (text === "") { jlog(contract, "infer", "empty output; retry next round"); continue; }
        const cps = Array.from(text);
        if (cps.length > MAX_CHARS) { text = cps.slice(0, MAX_CHARS).join(""); jlog(contract, "infer", `output ${cps.length} chars > ${MAX_CHARS}: truncated`); }
        // 6. 納品（投稿の前に残す）
        const inf = { text, sha256: sha256Utf8(text), model: MODEL, line: infLine(contract, text, MODEL), ms: Date.now() - t0 };
        mark(deals, contract, "delivering", { inf });
        await post(me, d.room, inf.line, { gateUntilMs: d.claimByMs, onGateWait: (n) => jlog(contract, "inf", `gate busy, retry ${n}`) });
        mark(deals, contract, "delivered");
        jlog(contract, "inf", `ok sha256=${inf.sha256.slice(0, 16)} model=${MODEL} ${inf.ms}ms`);
      }
      if (d.stage === "delivered") {
        // 7. reveal（SPEC §3.4: locked の間、refundAfterMs 前、ref は lock.ref）
        if (Date.now() >= d.refundAfterMs) { mark(deals, contract, "late"); jlog(contract, "reveal", "gave up: refundAfterMs passed"); continue; }
        const reveal = { type: "reveal", from: me.did, contract, ref: d.lock_ref, secret: d.preimage };
        await post(me, d.room, reveal, { gateUntilMs: d.claimByMs, onGateWait: (n) => jlog(contract, "reveal", `gate busy, retry ${n}`) });
        mark(deals, contract, "revealed");
        jlog(contract, "reveal", "ok");
        try { await rail.claim(d.lock_ref, d.preimage); } catch (e) { jlog(contract, "rail-claim", `skip ${e.message}`); }
        try { const sn = stateNote(contract); await notes.set(sn.ns, sn.key, stateNoteValue("claimed", d.lock_ref), { if: stateNoteValue("locked", d.lock_ref) }); }
        catch (e) { jlog(contract, "state-note", `skip ${e.message}`); }
      }
    } catch (e) {
      jlog(contract, d.stage, e.gate ? `gave up: gate busy until claimByMs (${e.message})` : `error ${e.message}`);
    }
  }
  // delivering のまま残った契約（納品の着地が不明）: 部屋に自分の inf があれば delivered、無ければ locked に戻して次の周で推論し直す
  for (const [contract, d] of Object.entries(deals)) {
    if (d.stage !== "delivering") continue;
    const msgs = await readTail(d.room).catch(() => []);
    const landed = msgs.some((m) => m.from === me.did && String(m.text ?? "").startsWith("hakoniwa/0 ") && String(m.text).includes(`"sha256":"${d.inf.sha256}"`));
    mark(deals, contract, landed ? "delivered" : "locked");
    jlog(contract, "inf", landed ? "landed (seen in room)" : "not landed; will infer again next round");
  }
}

// ── 本体 ──
const EXPLAIN = argv.includes("--explain") ? argv[argv.indexOf("--explain") + 1] : null;
const BOARD_ARG = argv.includes("--board") ? argv[argv.indexOf("--board") + 1] : null;
function readSavedBoard(target) {
  // --dry-run / --explain --export: 保存済みの掲示板（hako_export.py の <dir>/*.jsonl か 1 ファイル）
  const files = statSync(target).isDirectory()
    ? readdirSync(target).filter((f) => f.endsWith(".jsonl")).sort().map((f) => path.join(target, f))
    : [target];
  const rows = [];
  for (const f of files) rows.push(...parseBoardLines(readFileSync(f, "utf8")));
  return parseJoins(rows);
}
if (DRY_RUN || EXPLAIN) {
  // 鍵があれば自分の DID を出す（無ければその条件は省略）
  let myDid = null;
  if (process.env.TC_PASS) { try { myDid = loadSigner(KEY_PATH, process.env.TC_PASS).did; } catch { myDid = null; } }
  const deals = readJson(DEALS_PATH, {});
  const now = Date.now();
  if (EXPLAIN) {
    // --explain <offer id の先頭>: いまの /r/tclk-offers/export（--export があればそのファイル）からその offer を取り、条件を 1 つずつ当てる
    const exp = EXPORT_ARG ? readSavedExport(EXPORT_ARG) : await fetchOffersExport();
    const board = EXPORT_ARG ? readSavedBoard(BOARD_ARG ?? path.join(homedir(), "hako_export", BOARD_ROOM)) : await fetchJoins(BASE, req);
    const allFrames = decodeAll(exp.rows);
    const hits = allFrames.filter((x) => x.frame.type === "offer" && String(x.frame.id).startsWith(EXPLAIN));
    log("", `explain  ${EXPORT_ARG ?? `${BASE}/r/${OFFER_ROOM}/export`}  gen ${exp.generation}  rows ${exp.rows.length}  matching offers ${hits.length}`);
    log("", `board    joined ${board.joined.size} DID ${[...board.joined].map(([d, e]) => `…${d.slice(-5)}[${e.roles.join(",")}]`).join(" ")}  (bad_sig ${board.stats.bad_sig})`);
    log("", `state    cursor ${JSON.stringify(readJson(CURSOR_PATH, null))}  deals ${Object.keys(deals).length} 件 ${JSON.stringify(Object.fromEntries(Object.entries(deals).map(([c, d]) => [c.slice(0, 18), `${d.job} ${d.stage}`])))}`);
    log("", `me       ${myDid ?? "(鍵なし)"}   ollama ${OLLAMA}: ${(await ollamaReady()) ?? "ok, model " + MODEL}`);
    for (const { seq, ts, from, frame: f } of hits) {
      log("", `offer    seq ${seq}  ts ${ts}  from …${String(from).slice(-5)}  id ${f.id}`);
      log("", `         job ${JSON.stringify(f.job)}`);
      const checks = judge(f, { acceptsByRef: indexAccepts(allFrames), myDid, mine: new Set(Object.values(deals).map((d) => d.offer_id)), now, joined: board.joined });
      for (const c of checks) log("", `  ${c.ok ? "ok  " : "NG  "} ${c.cond.padEnd(28)} ${c.actual}`);
      const cur = readJson(CURSOR_PATH, null);
      if (cur) log("", `  ${seq <= cur.last_seq ? "info" : "info"} cursor last_seq ${cur.last_seq}: この行は ${seq <= cur.last_seq ? "処理済みの周に含まれていた" : "まだ見ていない"}`);
      log("", `  → ${checks.every((c) => c.ok) ? "候補になる" : "候補にならない: " + failText(checks.filter((c) => !c.ok))}`);
    }
    process.exit(hits.length > 0 ? 0 : 1);
  }
  const target = EXPORT_ARG ?? path.join(homedir(), "hako_export", OFFER_ROOM);
  const exp = readSavedExport(target);
  const boardDir = BOARD_ARG ?? path.join(homedir(), "hako_export", BOARD_ROOM);
  let board = { joined: new Map(), stats: { bad_sig: 0 } };
  try { board = readSavedBoard(boardDir); } catch { log("", `  board ${boardDir} が読めない: join 済み DID は 0 として判定`); }
  const allFrames = decodeAll(exp.rows);
  const found = candidates(allFrames, allFrames, myDid, {}, now, board.joined,
    (seq, f, fails) => log("", `  skip seq ${seq}  job ${f.job.id}  amount ${f.amount} — ${failText(fails)}`));
  const infOffers = allFrames.filter((x) => x.frame.type === "offer" && x.frame.job && String(x.frame.job.id ?? "").startsWith(JOB_PREFIX));
  log("", `dry-run  export ${target}  rows ${exp.rows.length}  frames ${allFrames.length}  ${JOB_PREFIX}* offers ${infOffers.length}  candidates ${found.length}  joined ${board.joined.size}${myDid ? "" : "  (own-offer check skipped: no key)"}`);
  for (const { seq, offer } of found) log("", `  seq ${seq}  job ${offer.job.id}  amount ${offer.amount}  expires ${new Date(offer.expiresMs).toISOString()}`);
  process.exit(0);
}
if (!process.env.TC_PASS) { console.error("TC_PASS(パスフレーズ)が未設定です"); process.exit(2); }
const me = loadSigner(KEY_PATH, process.env.TC_PASS);
if (process.env.EXPECT_DID && process.env.EXPECT_DID !== me.did) {
  console.error(`鍵から導出したDIDが期待値と不一致: ${me.did}`); process.exit(2);
}
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
setLogFile(LOG_PATH);
log("", `venue  ${BASE}`);
log("", `miner  ${me.did}`);
log("", `model  ${MODEL} @ ${OLLAMA}   min ${MIN_AMOUNT} PAPER   every ${INTERVAL_SEC}s   state ${STATE_DIR}`);
for (;;) {
  try { await step(me); } catch (e) { jlog("-", "round", `error ${e.message}`); }
  if (ONCE) break;
  await sleep(INTERVAL_SEC * 1000);
}

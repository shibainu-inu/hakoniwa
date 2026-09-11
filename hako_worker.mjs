#!/usr/bin/env node
// hako_worker.mjs — 箱庭の worker（ルール v0.7）。client の「あなたの今日の日記を書いて」の offer を 1 日 1 本受け、自分の数字のノートを置き、
// miner から推論を買って自分の日記を書き、納品して reveal する。役の表（HAKONIWA-RULES.md v0.7「動き方」）の worker の行を 1 周にしたもの。
// 用法: read -s TC_PASS && export TC_PASS   # パスフレーズは端末に打つ。コマンド行に書かない
//       node hako_worker.mjs                # 10 分ごとのループ（HAKO_WORKER_INTERVAL_SEC で変更）
//       node hako_worker.mjs --dry-run [--export <dir|file>] [--board <dir|file>]   # 日記 offer の候補の抽出だけ（鍵は要らない）
//       node hako_worker.mjs --once
// 環境変数: KEY_PATH (既定 ~/did_miner.json = …88xr), TCLK_DIR, TECHNOCORE_URL,
//   HAKO_STATS (自分の 5 つの数字と運営 DID の一覧を読む fold の出力。ファイルか URL。既定 ~/hako_stats/latest.json。
//     参加者は https://shibainu-inu.github.io/hakoniwa-site/latest.json を渡す。自分の DID がまだ無ければ 入ったばかりの数字 1,000 / 0 で置く),
//   HAKO_WORKER_INTERVAL_SEC (既定 600), HAKO_WORKER_MIN (日記代の下限、既定 0), HAKO_WORKER_MAX_PER_ROUND (1 周に受ける数、既定 1),
//   HAKO_WORKER_INF_PRICE (推論代、既定 240), HAKO_WORKER_INF_EXPIRES_MIN / _CLAIMBY_MIN / _REFUND_MIN (推論 offer の期限、既定 120 / 240 / 360 分。
//   日記の契約の claimByMs を超えない), HAKO_WORKER_INF_RETRIES (推論 offer の出し直し回数、既定 2),
//   HAKO_WORKER_STATE (既定 ~/.hako_worker), HAKO_WORKER_LOG (既定 ~/hako_worker.log), HAKO_RULES_PY (既定 ./hako_rules.py)
//
// 1 周ですること（各段の状態は state/jobs.json。日記の契約 id がキー）:
//   1. /r/tclk-offers/export を丸ごと取り、(generation, seq) で新しい行だけを候補にする。掲示板の join も 1 回読む
//   2. 候補（client の日記 offer）: type offer / role payer / asset PAPER / rails に paper / lock hash / job.id が hakoniwa-diary- /
//      amount ≥ HAKO_WORKER_MIN / expiresMs と claimByMs 未到来 / 自分の offer ではない（client ≠ worker）/
//      出した DID が庭に join 済みで client 役 / 運営以外の join 済み DID の accept が先に無い（決定 12。client は運営以外を先に lock するので、
//      運営 worker の accept が先にあっても受けてよい）/ 今日（UTC）まだ自分の日記の契約が無い（1 worker 1 日 1 本）。乱数は切り、1 周に 1 件受ける
//   3. 自分の context ノート /kv/hakoniwa-<自分の末尾 8 小文字>/diary-<YYYYMMDD>（5 つの数字は HAKO_STATS から。整数、桁区切りなし）を置いてから
//      accept（hash lock）。accept と preimage は投稿前に jobs.json（0600）に残す
//   4. client の lock を待つ（PaperRail.verifyLock）。claimByMs までに無ければ諦める
//   5. lock を見たら、自分のノートの数字と自分の性格（hako_rules.py personality）で README「日記の依頼文」の型の依頼文を組んで
//      自分のノート /kv/hakoniwa-<自分の末尾 8 小文字>/inf-<日記の契約先頭 8>-<通し番号> に置き、推論 offer を出す（払う側）
//   6. 推論 offer への accept から、決定 12 の選び方（join 済み・miner 役・自分以外・seq 最初）で 1 件を lock する（門は claimByMs まで再送）。
//      expiresMs までに該当が無ければ通し番号を進めて出し直す（HAKO_WORKER_INF_RETRIES 回まで）
//   7. miner の inf と reveal を待つ。sha256 と秘密を確かめて receipt。refundAfterMs を過ぎても reveal が無ければ refund
//   8. 納品前に本文を確かめる（hako_rules.py check-diary）。5 つの値と一致しない数字は消し、140 字に収める。それ以外は 1 字も変えない。
//      通れば diary の行（for は自分の DID）を日記の部屋に納品し、reveal（preimage）。receipt は client の仕事なので待たない
//   9. 1 件ごとに log に 1 行（時刻、日記の契約先頭 16、段階、結果）
// 依頼文の「私の性格」の行は hako_rules.py personality <自分の DID>（決定 13）で決める。「昨日から起きたこと」の節は fold が出すまで入れない。
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchJoins, hasRole, parseJoins, parseExportLines as parseBoardLines } from "./hako_board.mjs";
import { BOX, BOARD_ROOM, OFFER_ROOM, jobPrefix } from "./hako_box.mjs";
import {
  core, BASE, log, sleep, nowZ, fileLog, setLogFile, loadSigner, req, readTail, post, notes, fetchExport, GateClosed,
  readJson, saveJson, readSavedExport, splitNew, decodeAll, indexAccepts, sha256Utf8, hakoLine, contextPath,
} from "./hako_common.mjs";

const {
  PaperRail, applyFrame, canonicalJson, contractId, dealRoom, encodeFrame, generateHashLock,
  lockTerms, makeOffer, openContract, stateNote, stateNoteValue, tryDecodeFrame,
} = core;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY_PATH = process.env.KEY_PATH ?? path.join(homedir(), "did_miner.json");
const STATS = process.env.HAKO_STATS ?? path.join(homedir(), "hako_stats", "latest.json");
const INTERVAL_SEC = Number(process.env.HAKO_WORKER_INTERVAL_SEC ?? BOX.worker_interval_sec);   // 数字と名前の既定は hako_box.json（決定 16）。env で上書き
const MIN_AMOUNT = Number(process.env.HAKO_WORKER_MIN ?? 0);
const MAX_PER_ROUND = Number(process.env.HAKO_WORKER_MAX_PER_ROUND ?? 1);
const INF_PRICE = String(process.env.HAKO_WORKER_INF_PRICE ?? BOX.inference_price);
const INF_EXPIRES_MIN = Number(process.env.HAKO_WORKER_INF_EXPIRES_MIN ?? 120);
const INF_CLAIMBY_MIN = Number(process.env.HAKO_WORKER_INF_CLAIMBY_MIN ?? 240);
const INF_REFUND_MIN = Number(process.env.HAKO_WORKER_INF_REFUND_MIN ?? 360);
const INF_RETRIES = Number(process.env.HAKO_WORKER_INF_RETRIES ?? 2);
const STATE_DIR = process.env.HAKO_WORKER_STATE ?? path.join(homedir(), ".hako_worker");
const LOG_PATH = process.env.HAKO_WORKER_LOG ?? path.join(homedir(), "hako_worker.log");
const RULES_PY = process.env.HAKO_RULES_PY ?? path.join(HERE, "hako_rules.py");
const JOB_PREFIX = jobPrefix("diary");
const MAX_CHARS = 140;
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const ONCE = argv.includes("--once");
const EXPORT_ARG = argv.includes("--export") ? argv[argv.indexOf("--export") + 1] : null;
const BOARD_ARG = argv.includes("--board") ? argv[argv.indexOf("--board") + 1] : null;

function jlog(contract, stage, result) {
  const line = `${nowZ()} ${String(contract).slice(0, 16)} ${stage} ${result}`;
  console.log(line);
  fileLog(LOG_PATH, line);
}
const CURSOR_PATH = path.join(STATE_DIR, "cursor.json");
const JOBS_PATH = path.join(STATE_DIR, "jobs.json");
const loadJobs = () => readJson(JOBS_PATH, {});
const saveJobs = (jobs) => saveJson(JOBS_PATH, jobs, 0o600);
function mark(jobs, contract, stage, extra) {
  Object.assign(jobs[contract], extra ?? {}, { stage, updated: nowZ() });
  saveJobs(jobs);
}
const short = (did) => "…" + String(did).slice(-5);
const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : String(ms));

// ── 2. 日記 offer の候補条件（1 つずつ。落ちた条件は実際の値と一緒に残す） ──
function judge(f, { acceptsByRef, myDid, mine, now, joined, operators, doneToday }) {
  const accs = acceptsByRef.get(f.id) ?? [];
  const e = joined.get(f.from);
  const blocking = accs.filter((a) => joined.has(a.from) && !operators.has(a.from));   // 運営以外の join 済み DID の accept
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
    { cond: "自分の offer ではない（client ≠ worker）", ok: myDid === null || f.from !== myDid, actual: myDid === null ? "(鍵なし: 判定省略)" : short(f.from) },
    { cond: "出した DID が join 済みで client 役", ok: !!e && hasRole(e, "client"), actual: e ? `${short(f.from)} [${e.roles.join(",")}]` : `${short(f.from)} join していない` },
    { cond: "運営以外の join 済み DID の accept が先に無い", ok: blocking.length === 0,
      actual: accs.length === 0 ? "none" : accs.map((a) => `seq ${a.seq} ${short(a.from)}${joined.has(a.from) ? (operators.has(a.from) ? " (運営)" : " (join 済み)") : " (庭の外)"}`).join("; ") },
    { cond: "自分がまだ accept していない", ok: !mine.has(f.id), actual: mine.has(f.id) ? "jobs.json にある" : "none" },
    { cond: "今日（UTC）まだ自分の日記の契約が無い", ok: !doneToday, actual: doneToday ? "jobs.json に今日の契約がある" : "none" },
  ];
}
const failText = (fails) => fails.map((c) => `${c.cond}: ${c.actual}`).join(" | ");
const DEAD_STAGES = new Set(["expired", "no_lock"]);                    // 今日の 1 本として数えない段（契約にならなかった）
function candidates(allFrames, freshFrames, myDid, jobs, now, joined, onSkip, operators = new Set()) {
  const today = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
  const doneToday = Object.values(jobs).some((j) => j.date === today && !DEAD_STAGES.has(j.stage));
  const ctx = { acceptsByRef: indexAccepts(allFrames), myDid, mine: new Set(Object.values(jobs).map((j) => j.offer_id)), now, joined, operators, doneToday };
  const out = [];
  for (const { seq, ts, frame: f } of freshFrames) {
    if (f.type !== "offer") continue;
    const fails = judge(f, ctx).filter((c) => !c.ok);
    if (fails.length === 0) { out.push({ seq, ts, offer: f }); continue; }
    if (onSkip && f.job && typeof f.job.id === "string" && f.job.id.startsWith(JOB_PREFIX)) onSkip(seq, f, fails);
  }
  return out;
}

// ── 3. 自分の数字（fold の出力 HAKO_STATS。ファイルか URL）と運営 DID ──
const NUM_KEYS = ["earn", "spend", "balance", "mem_bytes", "life_days"];
const FRESH = { earn: 0, spend: 0, balance: 1000, mem_bytes: 0, life_days: null };   // 入ったばかり（fold にまだ無い）の数字
async function readStats() {
  try {
    if (/^https?:\/\//.test(STATS)) {
      const r = await fetch(STATS, { signal: AbortSignal.timeout(30_000) });
      return r.ok ? await r.json() : null;
    }
    return readJson(STATS, null);
  } catch { return null; }
}
function ownNote(stats, did, date8, joinedEntry) {
  const d = stats?.did?.[did];
  const int = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));
  const src = d ?? FRESH;
  return {
    fresh: !d,
    note: { did, date: `${date8.slice(0, 4)}-${date8.slice(4, 6)}-${date8.slice(6, 8)}`,
            lang: joinedEntry?.lang ?? d?.lang ?? "en", roles: joinedEntry?.roles ?? d?.roles ?? [],
            earn: int(src.earn), spend: int(src.spend), balance: int(src.balance), mem_bytes: int(src.mem_bytes), life_days: int(src.life_days) },
  };
}

// ── 5. 依頼文（README「日記の依頼文」の型。出来事の節はまだ入れない） ──
function numText(v) { return v === null || v === undefined ? null : (typeof v === "string" ? v : JSON.stringify(v)); }
function personalityWords(did, lang) {
  // hako_rules.py personality <did>（決定 13）。取れなければ行を入れない
  const r = spawnSync("python3", [RULES_PY, "personality", did], { encoding: "utf8" });
  try { return JSON.parse(String(r.stdout).trim()).words[lang === "ja" ? "ja" : "en"] ?? []; } catch { return []; }
}
function buildPrompt(ctx, clientDid) {
  const n = Object.fromEntries(NUM_KEYS.map((k) => [k, numText(ctx[k])]));
  const allowed = NUM_KEYS.map((k) => n[k]).filter((v) => v !== null);
  const words = clientDid ? personalityWords(clientDid, ctx.lang) : [];
  if (ctx.lang === "ja") {
    return [
      "あなたは HAKONIWA という庭に住む HAKO です。今日の日記を、一人称「私」で書いてください。",
      "",
      "私の数字（これだけが事実です）:",
      `- 稼ぎ ${n.earn ?? "0"}`,
      `- 食費 ${n.spend ?? "0"}`,
      `- 貯え ${n.balance ?? "0"}`,
      `- 記憶 ${n.mem_bytes ?? "0"} バイト`,
      n.life_days === null ? "- 余命 数えられない（食費がゼロのため）" : `- 余命 ${n.life_days} 日`,
      ...(words.length ? ["", `私の性格: ${words.join("、")}`] : []),
      "",
      "決まり:",
      "- 1〜2 文、120 文字以内（上限は 140 文字。途中で切れないように短く）", "- 季節や祝日や日付を勝手に決めない（挨拶で始めない）",
      `- 書いてよい数字は上の ${allowed.length} つだけ。回数や日付や時間は数字で書かず、言葉で書く（「一回」「きのう」）`,
      "- 上の数字を変えない。増やさない。丸めない",
      "- 定型の言い回しを避け、今日の数字から言葉を選ぶ",
      "- 日記の本文だけを返す。前置き、引用符、説明は付けない",
    ].join("\n");
  }
  return [
    "You are a HAKO living in a garden called HAKONIWA. Write today's diary entry in the first person.",
    "",
    "My numbers (these are the only facts):",
    `- earned ${n.earn ?? "0"}`,
    `- spent ${n.spend ?? "0"}`,
    `- savings ${n.balance ?? "0"}`,
    `- memory ${n.mem_bytes ?? "0"} bytes`,
    n.life_days === null ? "- days left: cannot be counted (spending is zero)" : `- days left: ${n.life_days}`,
    ...(words.length ? ["", `My character: ${words.join(", ")}`] : []),
    "",
    "Rules:",
    "- One or two sentences, 120 characters or fewer (hard limit 140; keep it short so nothing is cut off)", "- Do not invent the season, a holiday, or the date (no greetings)",
    `- The only digits you may write are the ${allowed.length} numbers above. Do not write counts, dates, or times as digits; use words`,
    "- Do not change, add to, or round the numbers above",
    "- Avoid stock phrases; choose words from today's numbers",
    "- Return only the diary text. No preamble, quotation marks, or explanation",
  ].join("\n");
}

// ── 8. 納品前の確かめ（hako_rules.py check-diary）と、数字だけ直す ──
function checkDiary(diary, ctxValues, client, date8, worker, meta) {
  // hako_rules.py check-diary は不合格のとき exit 1 を返す（結果は標準出力の JSON）。exit code では判断しない
  const inp = JSON.stringify({ diary, context: ctxValues, client, date: date8, worker, meta });
  const r = spawnSync("python3", [RULES_PY, "check-diary", "-"], { input: inp, encoding: "utf8" });
  const out = String(r.stdout ?? "").trim().split("\n").pop();
  if (!out) throw new Error(`check-diary produced no output (${(r.stderr ?? "").trim().slice(0, 120)})`);
  return JSON.parse(out);
}
const FULLWIDTH = "０１２３４５６７８９";
/** 140 字を超える本文は文の切れ目（。！？.!?）で切る。切れ目が前半に無ければ max で切る（2026-09-11: 実機の日記が「余命数えられない」で途切れた） */
function cutToSentence(text, max) {
  const cps = Array.from(text);
  if (cps.length <= max) return text;
  const head = cps.slice(0, max);
  let end = -1;
  for (let i = head.length - 1; i >= Math.floor(max / 2); i--) { if ("。！？.!?".includes(head[i])) { end = i; break; } }
  return (end >= 0 ? head.slice(0, end + 1) : head).join("").trim();
}
function fixNumbers(text, allowed) {
  // 5 つの値と一致しない数字の並びだけ消す（全角は半角に直してから比べる）。それ以外は 1 字も変えない
  const half = text.replace(/[０-９]/g, (c) => String(FULLWIDTH.indexOf(c)));
  return half.replace(/[0-9]+/g, (d) => (allowed.has(d) ? d : ""));
}

// ── 1 周 ──
async function step(me) {
  const jobs = loadJobs();
  const now = Date.now();
  const rail = new PaperRail(notes);
  const cursor = readJson(CURSOR_PATH, { generation: null, last_seq: 0 });
  const exp = await fetchExport(OFFER_ROOM);
  const { fresh, next } = splitNew(cursor, exp.generation, exp.rows, OFFER_ROOM);
  const allFrames = decodeAll(exp.rows);
  const freshFrames = decodeAll(fresh);
  const board = await fetchJoins(BASE, req);
  const accepted = indexAccepts(allFrames);
  const stats = await readStats();
  const operators = new Set(Array.isArray(stats?.box?.operators) ? stats.box.operators : []);

  // 2〜3. 日記 offer を受ける（乱数は切り、1 周に MAX_PER_ROUND 件。受ける前に自分の数字のノートを置く）
  const found = candidates(allFrames, freshFrames, me.did, jobs, now, board.joined,
    (seq, f, fails) => jlog(f.id, "skip", `seq ${seq} job=${f.job.id} amount=${f.amount} — ${failText(fails)}`), operators);
  const diaryOffers = freshFrames.filter((x) => x.frame.type === "offer" && String(x.frame.job?.id ?? "").startsWith(JOB_PREFIX)).length;
  jlog("-", "round", `gen ${exp.generation} rows ${exp.rows.length} new ${fresh.length} last_seq ${next.last_seq} ${JOB_PREFIX}* offers ${diaryOffers} candidates ${found.length} joined ${board.joined.size} (board bad_sig ${board.stats.bad_sig})${stats ? ` stats ${stats.box?.generated} operators ${operators.size}` : ` stats missing (${STATS})`}`);
  for (const { ts, offer } of found.slice(0, MAX_PER_ROUND)) {
    const date8 = String(ts).slice(0, 10).replace(/-/g, "");
    const own = ownNote(stats, me.did, date8, board.joined.get(me.did));
    const notePath = contextPath(me.did, "diary", date8);
    const [, ns, key] = notePath.match(/^\/kv\/([^/]+)\/([^/]+)$/);
    if (!(await notes.set(ns, key, JSON.stringify(own.note)))) { jlog(offer.id, "note", `cannot write ${notePath}; retry next round`); continue; }
    jlog(offer.id, "note", `ok ${notePath} ${NUM_KEYS.map((k) => `${k}=${own.note[k]}`).join(",")}${own.fresh ? " (not in stats yet: fresh numbers)" : ""}`);
    const hl = generateHashLock();
    const acceptCore = { from: me.did, ref: offer.id, statement: hl.hash, nonce: randomBytes(8).toString("hex") };
    const accept = { type: "accept", ...acceptCore, contract: contractId(offer, acceptCore) };
    let text;
    try { text = encodeFrame(accept); } catch { text = "tclk1 " + canonicalJson(accept); }
    const contract = accept.contract;
    jobs[contract] = {
      offer_id: offer.id, job: offer.job.id, amount: offer.amount, client: offer.from, note: notePath, ctx: own.note,
      offer_ts: ts, date: date8, claimByMs: offer.claimByMs, refundAfterMs: offer.refundAfterMs,
      offer, accept_text: text, accepted_at_ms: Date.now(), statement: hl.hash, preimage: hl.preimage, room: dealRoom(contract),
      inf: null, stage: "accepting", updated: nowZ(),
    };
    saveJobs(jobs);
    try {
      await post(me, OFFER_ROOM, text, { gateUntilMs: offer.claimByMs, onGateWait: (n) => jlog(contract, "accept", `gate busy, retry ${n}`) });
      mark(jobs, contract, "accepted");
      jlog(contract, "accept", `ok job=${offer.job.id} amount=${offer.amount} client=${short(offer.from)}`);
      try { const sn = stateNote(contract); await notes.set(sn.ns, sn.key, stateNoteValue("accepted"), { ifAbsent: true }); }
      catch (e) { jlog(contract, "state-note", `skip ${e.message}`); }
    } catch (e) { jlog(contract, "accept", `fail ${e.message}`); }
  }
  saveJson(CURSOR_PATH, next);

  // 3'. accepting のまま残った契約: export に着地していれば accepted、失効していれば expired、それ以外は出し直し（周期ぶん空く）
  for (const [contract, j] of Object.entries(jobs)) {
    if (j.stage !== "accepting") continue;
    if (allFrames.some((x) => x.frame.type === "accept" && x.frame.contract === contract && x.from === me.did)) { mark(jobs, contract, "accepted"); jlog(contract, "accept", "landed (seen in export)"); continue; }
    if (Date.now() >= j.offer.expiresMs) { mark(jobs, contract, "expired"); jlog(contract, "accept", "gave up: offer expired"); continue; }
    try { await post(me, OFFER_ROOM, j.accept_text, { gateUntilMs: j.claimByMs }); mark(jobs, contract, "accepted"); jlog(contract, "accept", "ok (re-sent)"); }
    catch (e) { jlog(contract, "accept", `fail (re-send) ${e.message}`); }
  }

  // 4〜8. 受けた契約を進める
  for (const [contract, j] of Object.entries(jobs)) {
    if (!["accepted", "locked", "inf_offered", "inf_locked", "inf_done", "delivered"].includes(j.stage)) continue;
    try {
      if (j.stage === "accepted") {
        // 4. client の lock
        const msgs = await readTail(j.room);
        let lock = null;
        for (const m of msgs) {
          const f = tryDecodeFrame(String(m.text ?? ""));
          if (f && f.type === "lock" && f.contract === contract && f.rail === "paper" && m.from === j.client) { lock = f; break; }
        }
        if (lock === null) {
          if (Date.now() > j.claimByMs) { mark(jobs, contract, "no_lock"); jlog(contract, "lock", "gave up: claimByMs passed without lock"); }
          continue;
        }
        const stepA = applyFrame(openContract(j.offer), tryDecodeFrame(j.accept_text), j.accepted_at_ms);
        if (!stepA.ok) { jlog(contract, "lock", `cannot rebuild contract state: ${stepA.reason}; retry next round`); continue; }
        const held = await rail.verifyLock(lockTerms(stepA.state), lock.ref).catch(() => false);
        if (!held) { jlog(contract, "lock", `seen but rail record does not match (ref=${lock.ref.slice(0, 18)}); retry next round`); continue; }
        mark(jobs, contract, "locked", { lock_ref: lock.ref });
        jlog(contract, "lock", `ok ref=${lock.ref.slice(0, 18)}`);
      }
      if (j.stage === "locked") {
        // 5. 自分のノートの数字 → 依頼文 → 自分の推論ノート → 推論 offer
        const ctx = j.ctx;
        if (!ctx || typeof ctx !== "object") { mark(jobs, contract, "bad_context"); jlog(contract, "context", "gave up: own note missing in jobs.json"); continue; }
        const n = (j.inf_tries ?? 0) + 1;
        if (n > INF_RETRIES + 1) { mark(jobs, contract, "inf_failed"); jlog(contract, "inf-offer", `gave up: no acceptable accept after ${n - 1} offers`); continue; }
        // ノートは 1 行（technocore の clean_text が改行を空白にする）。ここで畳んでから置き、miner に渡る本文と同じにしておく
        const prompt = buildPrompt(ctx, me.did).split("\n").join(" ").replace(/\s+/g, " ").trim();
        const notePath = contextPath(me.did, "inf", `${contract.slice(2, 10)}-${n}`);
        const [, ns, key] = notePath.match(/^\/kv\/([^/]+)\/([^/]+)$/);
        if (!(await notes.set(ns, key, prompt))) { jlog(contract, "inf-offer", `cannot write note ${notePath}; retry next round`); continue; }
        const t = Date.now();
        const cap = (min) => Math.min(t + min * 60_000, j.claimByMs);      // 日記の契約の claimByMs を超えない
        const claimBy = cap(INF_CLAIMBY_MIN);
        const infOffer = makeOffer({
          from: me.did, role: "payer", lock: "hash", amount: INF_PRICE, asset: "PAPER", rails: ["paper"],
          expiresMs: Math.min(cap(INF_EXPIRES_MIN), claimBy - 60_000), claimByMs: claimBy, refundAfterMs: Math.max(claimBy + 60_000, cap(INF_REFUND_MIN)),
          // 試験の日記（job.id に -test-）から出す推論 offer にも -test- を伝える（fold は -test- を含む契約を本番の数字に入れない）
          job: { proto: "hakoniwa", id: `${jobPrefix("inf")}${contract.slice(2, 10)}${j.job.includes("-test-") ? "-test" : ""}-${n}`, context: notePath },
        });
        mark(jobs, contract, "inf_offering", { inf_tries: n, ctx, inf: { offer: infOffer, note: notePath, job: infOffer.job.id } });
        await post(me, OFFER_ROOM, infOffer, { gateUntilMs: j.claimByMs, onGateWait: (k) => jlog(contract, "inf-offer", `gate busy, retry ${k}`) });
        mark(jobs, contract, "inf_offered");
        jlog(contract, "inf-offer", `ok ${infOffer.job.id} amount=${INF_PRICE} expires=${iso(infOffer.expiresMs)} note=${notePath}`);
      }
      if (j.stage === "inf_offered") {
        // 6. miner の accept を決定 12 で選んで lock
        const infOffer = j.inf.offer;
        const accs = (accepted.get(infOffer.id) ?? []).slice().sort((a, b) => a.seq - b.seq);
        let chosen = null;
        const why = [];
        for (const a of accs) {
          const f = a.frame, e = board.joined.get(a.from);
          const reasons = [];
          if (!e) reasons.push("join していない"); else if (!hasRole(e, "miner")) reasons.push(`役に miner が無い [${e.roles.join(",")}]`);
          if (a.from === me.did) reasons.push("自分");
          if (a.from !== f.from) reasons.push("署名者と from が違う");
          const expect = contractId(infOffer, { from: f.from, ref: f.ref, statement: f.statement, paymentKey: f.paymentKey, nonce: f.nonce });
          if (expect !== f.contract) reasons.push("contract id 不一致");
          why.push(`seq ${a.seq} ${short(a.from)}: ${reasons.length ? reasons.join(", ") : "採用"}`);
          if (reasons.length === 0) { chosen = a; break; }
        }
        if (chosen === null) {
          if (Date.now() >= infOffer.expiresMs) {
            jlog(contract, "inf-accept", `none acceptable by expiresMs (${why.join(" | ") || "no accept"}); re-offer next round`);
            mark(jobs, contract, "locked");                             // 通し番号を進めて出し直す（5 へ）
          }
          continue;
        }
        const infContract = chosen.frame.contract;
        const infRoom = dealRoom(infContract);
        const stepA = applyFrame(openContract(infOffer), chosen.frame, Date.parse(chosen.ts));
        if (!stepA.ok) { jlog(contract, "inf-accept", `cannot apply accept: ${stepA.reason}`); continue; }
        let ref;
        const existing = await rail.read(infContract).catch(() => null);
        if (existing && existing.statement === chosen.frame.statement) ref = infContract;
        else ref = await rail.lock(lockTerms(stepA.state));
        const lockFrame = { type: "lock", from: me.did, contract: infContract, rail: "paper", ref };
        mark(jobs, contract, "inf_locking", { inf: { ...j.inf, contract: infContract, room: infRoom, miner: chosen.from, accept: chosen.frame, accepted_at_ms: Date.parse(chosen.ts), lock: lockFrame } });
        jlog(contract, "inf-accept", `chose ${short(chosen.from)} seq ${chosen.seq} contract ${infContract.slice(0, 18)} (${why.join(" | ")})`);
        try {
          await post(me, infRoom, lockFrame, { gateUntilMs: infOffer.claimByMs, onGateWait: (k) => jlog(contract, "inf-lock", `gate busy, retry ${k}`) });
        } catch (e) {
          if (e.gate) { mark(jobs, contract, "inf_gate_closed"); jlog(contract, "inf-lock", "gave up: claimByMs passed while gate busy"); continue; }
          throw e;
        }
        mark(jobs, contract, "inf_locked");
        jlog(contract, "inf-lock", `ok room ${infRoom}`);
        try { const sn = stateNote(infContract); await notes.set(sn.ns, sn.key, stateNoteValue("locked", ref), { if: stateNoteValue("accepted") }); } catch { /* 参考情報 */ }
      }
      if (j.stage === "inf_locked") {
        // 7. miner の inf と reveal → receipt。無ければ refundAfterMs 以降に refund
        const infOffer = j.inf.offer, infContract = j.inf.contract;
        const msgs = await readTail(j.inf.room);
        let inf = null, reveal = null;
        for (const m of msgs) {
          const text = String(m.text ?? "");
          if (m.from !== j.inf.miner) continue;
          if (inf === null && text.startsWith("hakoniwa/0 ")) { try { const h = JSON.parse(text.slice(11)); if (h.t === "inf" && h.contract === infContract) inf = h; } catch { /* skip */ } }
          const f = tryDecodeFrame(text);
          if (f && f.type === "reveal" && f.contract === infContract) reveal = f;
        }
        if (reveal === null || inf === null) {
          if (Date.now() >= infOffer.refundAfterMs) {
            const refund = { type: "refund", from: me.did, contract: infContract, ref: j.inf.lock.ref };
            await post(me, j.inf.room, refund, { gateUntilMs: j.claimByMs });
            mark(jobs, contract, "inf_refunded");
            jlog(contract, "inf-refund", `no inf/reveal by refundAfterMs; refunded (inf=${inf !== null} reveal=${reveal !== null})`);
          }
          continue;
        }
        let view = applyFrame(openContract(infOffer), j.inf.accept, j.inf.accepted_at_ms).state;
        const stepL = applyFrame(view, j.inf.lock, j.inf.accepted_at_ms + 1);
        const stepR = stepL.ok ? applyFrame(stepL.state, reveal, Date.now()) : stepL;
        const shaOk = typeof inf.text === "string" && sha256Utf8(inf.text) === inf.sha256;
        if (!stepR.ok || stepR.state.status !== "claimed") { jlog(contract, "inf-receipt", `reveal rejected: ${stepR.reason}; retry next round`); continue; }
        if (!shaOk) { mark(jobs, contract, "inf_bad_sha"); jlog(contract, "inf-receipt", "inf sha256 does not match text; no receipt"); continue; }
        const receipt = { type: "receipt", from: me.did, contract: infContract, outcome: "claimed", rail: "paper", ref: j.inf.lock.ref };
        await post(me, j.inf.room, receipt, { gateUntilMs: j.claimByMs });
        mark(jobs, contract, "inf_done", { inf: { ...j.inf, text: inf.text, model: inf.model ?? null, sha256: inf.sha256 } });
        jlog(contract, "inf-receipt", `ok model=${inf.model} ${Array.from(inf.text).length} chars`);
      }
      if (j.stage === "inf_done") {
        // 8. 本文を確かめて diary を納品
        const allowed = new Set(NUM_KEYS.map((k) => numText(j.ctx[k])).filter((v) => v !== null));
        let text = String(j.inf.text).trim();
        const ctxValues = NUM_KEYS.map((k) => (j.ctx[k] === undefined ? null : j.ctx[k]));
        const date = `${j.date.slice(0, 4)}-${j.date.slice(4, 6)}-${j.date.slice(6, 8)}`;
        const meta = { signer: me.did, room: j.room, deal_room: j.room, before_reveal: true };
        const mk = (t) => ({ t: "diary", contract, for: me.did, date, text: t, sha256: sha256Utf8(t), model: j.inf.model ?? "unknown", nonce: randomBytes(8).toString("hex") });
        let r = checkDiary(mk(text), ctxValues, j.client, j.date, me.did, meta);
        if (r.ok !== true) {
          // 数字だけ直す: 5 つの値と一致しない数字は消す。長ければ切る。それ以外は変えない
          const fixed = cutToSentence(fixNumbers(text, allowed).trim(), MAX_CHARS);
          const r2 = checkDiary(mk(fixed), ctxValues, j.client, j.date, me.did, meta);
          jlog(contract, "diary-check", `first: ok=${r.ok} ${r.reason} → after fixing numbers: ok=${r2.ok} ${r2.reason}`);
          if (r2.ok !== true) { mark(jobs, contract, "diary_rejected", { diary_check: r2 }); jlog(contract, "diary", "gave up: text does not pass the 5 checks"); continue; }
          text = fixed; r = r2;
        }
        const diary = mk(text);
        mark(jobs, contract, "delivering", { diary });
        await post(me, j.room, hakoLine(diary), { gateUntilMs: j.claimByMs, onGateWait: (k) => jlog(contract, "diary", `gate busy, retry ${k}`) });
        mark(jobs, contract, "delivered");
        jlog(contract, "diary", `ok ${Array.from(text).length} chars sha256=${diary.sha256.slice(0, 16)} text=${text}`);
      }
      if (j.stage === "delivered") {
        // reveal（SPEC §3.4: locked の間、refundAfterMs 前、ref は lock.ref）
        if (Date.now() >= j.refundAfterMs) { mark(jobs, contract, "late"); jlog(contract, "reveal", "gave up: refundAfterMs passed"); continue; }
        const reveal = { type: "reveal", from: me.did, contract, ref: j.lock_ref, secret: j.preimage };
        await post(me, j.room, reveal, { gateUntilMs: j.claimByMs });
        mark(jobs, contract, "revealed");
        jlog(contract, "reveal", "ok");
        try { await rail.claim(j.lock_ref, j.preimage); } catch (e) { jlog(contract, "rail-claim", `skip ${e.message}`); }
        try { const sn = stateNote(contract); await notes.set(sn.ns, sn.key, stateNoteValue("claimed", j.lock_ref), { if: stateNoteValue("locked", j.lock_ref) }); } catch { /* 参考情報 */ }
      }
    } catch (e) {
      jlog(contract, j.stage, e.gate ? `gave up: gate busy until claimByMs (${e.message})` : `error ${e.message}`);
    }
  }
  // 投稿の着地が不明のまま残った段（inf_offering / inf_locking / delivering）: 次の周は部屋と export を見て判断する
  for (const [contract, j] of Object.entries(jobs)) {
    if (j.stage === "inf_offering") {
      const landed = allFrames.some((x) => x.frame.type === "offer" && x.frame.id === j.inf.offer.id);
      mark(jobs, contract, landed ? "inf_offered" : "locked"); jlog(contract, "inf-offer", landed ? "landed (seen in export)" : "not landed; will offer again");
    } else if (j.stage === "inf_locking") {
      const msgs = await readTail(j.inf.room).catch(() => []);
      const landed = msgs.some((m) => m.from === me.did && tryDecodeFrame(String(m.text ?? ""))?.type === "lock");
      mark(jobs, contract, landed ? "inf_locked" : "inf_offered"); jlog(contract, "inf-lock", landed ? "landed (seen in room)" : "not landed; will lock again");
    } else if (j.stage === "delivering") {
      const msgs = await readTail(j.room).catch(() => []);
      const landed = msgs.some((m) => m.from === me.did && String(m.text ?? "").includes(`"sha256":"${j.diary.sha256}"`));
      mark(jobs, contract, landed ? "delivered" : "inf_done"); jlog(contract, "diary", landed ? "landed (seen in room)" : "not landed; will deliver again");
    }
  }
}

// ── 本体 ──
if (DRY_RUN) {
  let myDid = null;
  if (process.env.TC_PASS) { try { myDid = loadSigner(KEY_PATH, process.env.TC_PASS).did; } catch { myDid = null; } }
  const target = EXPORT_ARG ?? path.join(homedir(), "hako_export", OFFER_ROOM);
  const boardDir = BOARD_ARG ?? path.join(homedir(), "hako_export", BOARD_ROOM);
  const exp = readSavedExport(target);
  let board = { joined: new Map(), stats: { bad_sig: 0 } };
  try { board = parseJoins(readSavedExport(boardDir).rows); } catch { log("", `  board ${boardDir} が読めない: join 済み DID は 0 として判定`); }
  const allFrames = decodeAll(exp.rows);
  const found = candidates(allFrames, allFrames, myDid, {}, Date.now(), board.joined,
    (seq, f, fails) => log("", `  skip seq ${seq}  job ${f.job.id}  amount ${f.amount} — ${failText(fails)}`));
  const diaryOffers = allFrames.filter((x) => x.frame.type === "offer" && String(x.frame.job?.id ?? "").startsWith(JOB_PREFIX)).length;
  log("", `dry-run  export ${target}  rows ${exp.rows.length}  frames ${allFrames.length}  ${JOB_PREFIX}* offers ${diaryOffers}  candidates ${found.length}  joined ${board.joined.size}${myDid ? "" : "  (own-offer check skipped: no key)"}`);
  for (const { seq, offer } of found) log("", `  seq ${seq}  job ${offer.job.id}  amount ${offer.amount}  client ${short(offer.from)}  expires ${iso(offer.expiresMs)}`);
  process.exit(0);
}
if (!process.env.TC_PASS) { console.error("TC_PASS(パスフレーズ)が未設定です"); process.exit(2); }
const me = loadSigner(KEY_PATH, process.env.TC_PASS);
if (process.env.EXPECT_DID && process.env.EXPECT_DID !== me.did) { console.error(`鍵から導出したDIDが期待値と不一致: ${me.did}`); process.exit(2); }
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
setLogFile(LOG_PATH);
log("", `venue  ${BASE}`);
log("", `worker ${me.did}`);
log("", `inf price ${INF_PRICE} PAPER   diary min ${MIN_AMOUNT}   every ${INTERVAL_SEC}s   state ${STATE_DIR}`);
for (;;) {
  try { await step(me); } catch (e) { jlog("-", "round", `error ${e.message}`); }
  if (ONCE) break;
  await sleep(INTERVAL_SEC * 1000);
}

#!/usr/bin/env node
// hako_keeper.mjs — 箱庭の keeper（ルール v0.11「keeper — 記憶を預かる商売」、決定 18）。
// hakoniwa-keep- の offer を受け、依頼のノートから本文を取り、本体は自分の保管に置き、keep を納品して reveal する。
// 掲示板の recall に応えて serve を出す。本体はノートに置かない（ルール「ノートは索引だけ」）。
// 土台は hako_miner.mjs（同じ 1 周の形）。推論の代わりに「保管」をする。
// 用法: read -s TC_PASS && export TC_PASS   # パスフレーズは端末に打つ。コマンド行に書かない
//       node hako_keeper.mjs            # 周期ごとのループ
//       node hako_keeper.mjs --dry-run [--export <dir|file>]   # 候補の抽出だけ（保存済み export を読む。鍵は要らない）
//       node hako_keeper.mjs --once      # 1 周だけ
// 環境変数: KEY_PATH (既定 ~/did_key.json), TCLK_DIR (既定 ~/tclk), TECHNOCORE_URL,
//   HAKO_KEEPER_INTERVAL_SEC (既定 hako_box.json の client_interval_sec), HAKO_KEEPER_MIN (既定 hako_box.json の keep_price),
//   HAKO_KEEPER_STATE (既定 ~/.hako_keeper), HAKO_KEEPER_LOG (既定 ~/hako_keeper.log)
//
// keeper は自分から offer を出さず、部屋も作らない（lock を出す払う側が作る）。
// 1 周ですること:
//   1. /r/tclk-offers/export を丸ごと取り、(generation, seq) で新しい行だけを候補にする（cursor は state/cursor.json）
//   2. 候補: type offer / role payer / asset PAPER / rails に paper / lock hash / job.id が hakoniwa-keep- /
//      amount ≥ HAKO_KEEPER_MIN / expiresMs 未到来 / claimByMs 未到来 / 自分の offer ではない /
//      出した DID が join 済み / 庭に join 済みの DID の accept が先に無い（決定 12）
//   3. accept（hash lock）。accept と preimage は投稿前に state/keeps.json（0600）に残す
//   4. 払う側の lock を待つ（claimByMs まで）
//   5. lock を確認したら offer.job.context のノートを読む。中身は 1 行 JSON {"sha256","text","for","date"}。
//      sha256 が本文と合わなければ預からない（no_body）
//   6. 本体を自分の保管（state/kept/<sha256>.json）に書き、索引ノート /kv/<箱>-<自分の末尾 8>/keeps を更新する（1 人 1 ノート）
//   7. keep の行（sha256 / for / until / how）を派生ルームに納品して reveal。receipt は払う側の仕事なので待たない
//   8. 掲示板の recall（{"t":"recall","sha256":...}）に、保管していれば serve（本文つき）を 1 回だけ返す
// 保管代は 85% が自分の稼ぎ、15% は庭の外へ出る（hako_box.json の keep_burn_share）。fold がそう数える。
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fetchJoins, hasRole, parseJoins, parseExportLines as parseBoardLines } from "./hako_board.mjs";
import { BOX, BOARD_ROOM, OFFER_ROOM, jobPrefix, noteNs } from "./hako_box.mjs";
import {
  core, BASE, log, sleep, nowZ, setLogFile, loadSigner, req, readTail, post, notes, fetchExport,
  readJson, saveJson, readSavedExport, splitNew, decodeAll, indexAccepts, sha256Utf8, hakoLine,
} from "./hako_common.mjs";

const {
  applyFrame, canonicalJson, contractId, dealRoom, encodeFrame, generateHashLock,
  lockTerms, openContract, stateNote, stateNoteValue, tryDecodeFrame, PaperRail,
} = core;

const KEY_PATH = process.env.KEY_PATH ?? path.join(homedir(), "did_key.json");
const INTERVAL_SEC = Number(process.env.HAKO_KEEPER_INTERVAL_SEC ?? BOX.client_interval_sec);
const MIN_AMOUNT = Number(process.env.HAKO_KEEPER_MIN ?? BOX.keep_price);
const KEEP_DAYS = Number(process.env.HAKO_KEEPER_DAYS ?? BOX.keep_days);
const STATE_DIR = process.env.HAKO_KEEPER_STATE ?? path.join(homedir(), ".hako_keeper");
const LOG_PATH = process.env.HAKO_KEEPER_LOG ?? path.join(homedir(), "hako_keeper.log");
const JOB_PREFIX = jobPrefix("keep");
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const ONCE = argv.includes("--once");
const EXPORT_ARG = argv.includes("--export") ? argv[argv.indexOf("--export") + 1] : null;
const BOARD_ARG = argv.includes("--board") ? argv[argv.indexOf("--board") + 1] : null;

function jlog(contract, stage, result) {
  const line = `${nowZ()} ${String(contract).slice(0, 16)} ${stage} ${result}`;
  console.log(line);
  try { appendFileSync(LOG_PATH, line + "\n"); } catch { /* log が書けなくても止めない */ }
}

// ── 手元の状態 ──
const CURSOR_PATH = path.join(STATE_DIR, "cursor.json");
const KEEPS_PATH = path.join(STATE_DIR, "keeps.json");
const BOARD_CURSOR = path.join(STATE_DIR, "board_cursor.json");
const bodyPath = (sha) => path.join(STATE_DIR, "kept", `${sha}.json`);
const loadKeeps = () => readJson(KEEPS_PATH, {});
const saveKeeps = (k) => saveJson(KEEPS_PATH, k, 0o600);
function mark(keeps, contract, stage, extra) {
  Object.assign(keeps[contract], extra ?? {}, { stage, updated: nowZ() });
  saveKeeps(keeps);
}
const short = (did) => "…" + String(did).slice(-5);
const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : String(ms));

// ── 2. 候補条件（1 つずつ。落ちた条件は実際の値と一緒に残す） ──
function judge(f, { acceptsByRef, myDid, mine, now, joined }) {
  const accs = acceptsByRef.get(f.id) ?? [];
  const e = joined.get(f.from);
  return [
    { cond: "type offer", ok: f.type === "offer", actual: f.type },
    { cond: "role payer", ok: f.role === "payer", actual: f.role },
    { cond: "asset PAPER", ok: f.asset === "PAPER", actual: f.asset },
    { cond: "rails に paper", ok: Array.isArray(f.rails) && f.rails.includes("paper"), actual: JSON.stringify(f.rails) },
    { cond: "lock hash", ok: f.lock === "hash", actual: f.lock },
    { cond: `job.id が ${JOB_PREFIX}`, ok: !!f.job && typeof f.job.id === "string" && f.job.id.startsWith(JOB_PREFIX), actual: f.job?.id },
    { cond: "job.context が /kv/", ok: typeof f.job?.context === "string" && /^\/kv\/[^/]+\/[^/]+$/.test(f.job.context), actual: f.job?.context ?? "(無し)" },
    { cond: `amount ≥ ${MIN_AMOUNT}`, ok: /^[1-9][0-9]*$/.test(String(f.amount)) && Number(f.amount) >= MIN_AMOUNT, actual: f.amount },
    { cond: "expiresMs 未到来", ok: typeof f.expiresMs === "number" && now < f.expiresMs, actual: `${iso(f.expiresMs)} (now ${iso(now)})` },
    { cond: "claimByMs 未到来", ok: typeof f.claimByMs === "number" && now < f.claimByMs, actual: iso(f.claimByMs) },
    { cond: "自分の offer ではない", ok: myDid === null || f.from !== myDid, actual: myDid === null ? "(鍵なし: 判定省略)" : short(f.from) },
    { cond: "出した DID が join 済み", ok: !!e, actual: e ? `${short(f.from)} [${e.roles.join(",")}]` : `${short(f.from)} join していない` },
    { cond: "join 済み DID の accept が先に無い", ok: !accs.some((a) => joined.has(a.from)),
      actual: accs.length === 0 ? "none" : accs.map((a) => `seq ${a.seq} ${short(a.from)}${joined.has(a.from) ? " (join 済み)" : " (庭の外)"}`).join("; ") },
    { cond: "自分がまだ accept していない", ok: !mine.has(f.id), actual: mine.has(f.id) ? "keeps.json にある" : "none" },
  ];
}
const failText = (fails) => fails.map((c) => `${c.cond}: ${c.actual}`).join(" | ");
function candidates(allFrames, freshFrames, myDid, keeps, now, joined, onSkip) {
  const ctx = { acceptsByRef: indexAccepts(allFrames), myDid, mine: new Set(Object.values(keeps).map((k) => k.offer_id)), now, joined };
  const out = [];
  for (const { seq, frame: f } of freshFrames) {
    if (f.type !== "offer") continue;
    const fails = judge(f, ctx).filter((c) => !c.ok);
    if (fails.length === 0) { out.push({ seq, offer: f }); continue; }
    if (onSkip && f.job && typeof f.job.id === "string" && f.job.id.startsWith(JOB_PREFIX)) onSkip(seq, f, fails);
  }
  return out;
}

// ── 6. 索引ノート（1 人 1 ノート。中身は預かり一覧。本体は入れない） ──
function indexValue(keeps, myDid) {
  const items = Object.values(keeps)
    .filter((k) => k.stage === "revealed" || k.stage === "kept")
    .map((k) => ({ sha256: k.sha256, for: k.for, until: k.until }));
  return JSON.stringify({ keeper: myDid, count: items.length, updated: nowZ(), how: `recall on /r/${BOARD_ROOM}`, items });
}
async function writeIndex(me, keeps) {
  const ns = noteNs(me.did);
  try { return await notes.set(ns, "keeps", indexValue(keeps, me.did)); }
  catch (e) { jlog("-", "index", `skip ${e.message}`); return false; }
}

// ── 8. recall → serve ──
async function serveRecalls(me, keeps) {
  let cur = readJson(BOARD_CURSOR, { generation: null, last_seq: 0 });
  let exp;
  try { exp = await fetchExport(BOARD_ROOM); } catch (e) { jlog("-", "recall", `board export ${e.message}`); return; }
  const { fresh, next } = splitNew(cur, exp.generation, exp.rows, BOARD_ROOM);
  const have = new Map();
  for (const k of Object.values(keeps)) {
    if (k.stage !== "revealed" && k.stage !== "kept") continue;
    for (const v of (Array.isArray(k.volumes) ? k.volumes : (k.sha256 ? [{ sha256: k.sha256 }] : []))) have.set(v.sha256, k);
  }
  for (const m of fresh) {
    const t = String(m.text ?? "");
    if (!t.startsWith("hakoniwa/0 ")) continue;
    let f; try { f = JSON.parse(t.slice("hakoniwa/0 ".length)); } catch { continue; }
    if (f?.t !== "recall" || typeof f.sha256 !== "string") continue;
    const k = have.get(f.sha256);
    if (!k) continue;
    if (Array.isArray(k.served) && k.served.includes(m.seq)) continue;
    let body;
    try { body = JSON.parse(readFileSync(bodyPath(k.sha256), "utf8")); } catch { jlog(k.contract ?? "-", "serve", `本体が読めない ${k.sha256.slice(0, 16)}`); continue; }
    try {
      await post(me, BOARD_ROOM, hakoLine({ t: "serve", sha256: k.sha256, text: body.text, nonce: randomBytes(8).toString("hex") }));
      k.served = [...(k.served ?? []), m.seq];
      saveKeeps(keeps);
      jlog(k.contract ?? "-", "serve", `ok recall seq ${m.seq} sha256=${k.sha256.slice(0, 16)}`);
    } catch (e) { jlog(k.contract ?? "-", "serve", `fail ${e.message}`); }
  }
  saveJson(BOARD_CURSOR, next);
}

// ── 1 周 ──
async function step(me) {
  const keeps = loadKeeps();
  const now = Date.now();
  const rail = new PaperRail(notes);

  const cursor = readJson(CURSOR_PATH, { generation: null, last_seq: 0 });
  const exp = await fetchExport(OFFER_ROOM);
  const { fresh, next } = splitNew(cursor, exp.generation, exp.rows, OFFER_ROOM);
  const allFrames = decodeAll(exp.rows);
  const freshFrames = decodeAll(fresh);
  const board = await fetchJoins(BASE, req);
  const keepOffers = freshFrames.filter((x) => x.frame.type === "offer" && String(x.frame.job?.id ?? "").startsWith(JOB_PREFIX)).length;
  const found = candidates(allFrames, freshFrames, me.did, keeps, now, board.joined,
    (seq, f, fails) => jlog(f.id, "skip", `seq ${seq} job=${f.job.id} amount=${f.amount} — ${failText(fails)}`));
  jlog("-", "round", `gen ${exp.generation} rows ${exp.rows.length} new ${fresh.length} last_seq ${next.last_seq} ${JOB_PREFIX}* offers ${keepOffers} candidates ${found.length} joined ${board.joined.size} (board bad_sig ${board.stats.bad_sig}) kept ${Object.values(keeps).filter((k) => k.stage === "revealed").length}`);

  // 2〜3. accept
  for (const { offer } of found) {
    const hl = generateHashLock();
    const acceptCore = { from: me.did, ref: offer.id, statement: hl.hash, nonce: randomBytes(8).toString("hex") };
    const accept = { type: "accept", ...acceptCore, contract: contractId(offer, acceptCore) };
    let text;
    try { text = encodeFrame(accept); } catch { text = "tclk1 " + canonicalJson(accept); }
    const contract = accept.contract;
    keeps[contract] = {
      contract, offer_id: offer.id, job: offer.job.id, amount: offer.amount, payer: offer.from, context: offer.job.context,
      claimByMs: offer.claimByMs, refundAfterMs: offer.refundAfterMs, offer, accept_text: text,
      statement: hl.hash, preimage: hl.preimage, room: dealRoom(contract), stage: "accepting", updated: nowZ(),
      accepted_at_ms: Date.now(), sha256: null, for: null, until: null,
    };
    saveKeeps(keeps);
    try {
      await post(me, OFFER_ROOM, text, { gateUntilMs: offer.claimByMs, onGateWait: (n) => jlog(contract, "accept", `gate busy, retry ${n}`) });
      mark(keeps, contract, "accepted");
      jlog(contract, "accept", `ok job=${offer.job.id} amount=${offer.amount} client=${short(offer.from)}`);
      try { const sn = stateNote(contract); await notes.set(sn.ns, sn.key, stateNoteValue("accepted"), { ifAbsent: true }); }
      catch (e) { jlog(contract, "state-note", `skip ${e.message}`); }
    } catch (e) { jlog(contract, "accept", `fail ${e.message}`); }
  }
  saveJson(CURSOR_PATH, next);

  // 3'. accepting のまま残った契約
  for (const [contract, k] of Object.entries(keeps)) {
    if (k.stage !== "accepting") continue;
    if (allFrames.some((x) => x.frame.type === "accept" && x.frame.contract === contract && x.from === me.did)) { mark(keeps, contract, "accepted"); jlog(contract, "accept", "landed (seen in export)"); continue; }
    if (Date.now() >= k.offer.expiresMs) { mark(keeps, contract, "expired"); jlog(contract, "accept", "gave up: offer expired"); continue; }
    try { await post(me, OFFER_ROOM, k.accept_text, { gateUntilMs: k.claimByMs }); mark(keeps, contract, "accepted"); jlog(contract, "accept", "ok (re-sent)"); }
    catch (e) { jlog(contract, "accept", `fail (re-send) ${e.message}`); }
  }

  // 4〜7. lock を待ち、本体を預かり、keep を納品して reveal
  for (const [contract, k] of Object.entries(keeps)) {
    if (!["accepted", "locked", "kept", "delivered"].includes(k.stage)) continue;
    try {
      if (k.stage === "accepted") {
        const msgs = await readTail(k.room);
        const lock = msgs.map((m) => ({ m, f: tryDecodeFrame(String(m.text ?? "")) }))
          .find((x) => x.f && x.f.type === "lock" && x.f.contract === contract && x.f.rail === "paper" && x.m.from === k.payer)?.f;
        if (!lock) {
          if (Date.now() > k.claimByMs) { mark(keeps, contract, "no_lock"); jlog(contract, "lock", "gave up: claimByMs passed without lock"); }
          continue;
        }
        const acceptFrame = tryDecodeFrame(k.accept_text);
        const acceptedAt = typeof k.accepted_at_ms === "number" ? k.accepted_at_ms : Math.min(Date.now(), k.offer.expiresMs - 1);
        const stepA = applyFrame(openContract(k.offer), acceptFrame, acceptedAt);
        if (!stepA.ok) { jlog(contract, "lock", `cannot rebuild contract state: ${stepA.reason}; retry next round`); continue; }
        const held = await rail.verifyLock(lockTerms(stepA.state), lock.ref).catch(() => false);
        if (!held) { jlog(contract, "lock", `seen but rail record does not match; retry next round`); continue; }
        mark(keeps, contract, "locked", { lock_ref: lock.ref });
        jlog(contract, "lock", `ok ref=${lock.ref.slice(0, 18)}`);
      }
      if (k.stage === "locked") {
        // 5. 依頼のノート。2 つの形を読む（決定 34-2）:
        //    1 冊    {"sha256","text","for","date"}
        //    棚ごと  {"volumes":[{"sha256","text","for","date"}, …]}   1 契約で棚ぜんぶ
        //    どの冊も sha256 が本文と合わなければ、その契約は預からない（1 冊でも合わなければ全部やめる）
        if (Date.now() >= k.refundAfterMs) { mark(keeps, contract, "late"); jlog(contract, "body", "gave up: refundAfterMs passed"); continue; }
        const m = String(k.context).match(/^\/kv\/([^/]+)\/([^/]+)$/);
        const raw = m ? await notes.get(m[1], m[2]) : null;
        if (raw === null) { jlog(contract, "body", `ノートが読めない ${k.context}; retry next round`); continue; }
        let body; try { body = JSON.parse(raw); } catch { mark(keeps, contract, "no_body"); jlog(contract, "body", "ノートが JSON でない。預からない"); continue; }
        const vols = Array.isArray(body.volumes) ? body.volumes : [body];
        if (!vols.length) { mark(keeps, contract, "no_body"); jlog(contract, "body", "冊が 1 つも無い。預からない"); continue; }
        const bad = vols.find((v) => !v || typeof v.text !== "string" || sha256Utf8(v.text) !== v.sha256);
        if (bad) {
          mark(keeps, contract, "no_body"); jlog(contract, "body", "sha256 が本文と合わない。預からない"); continue;
        }
        // 6. 本体は自分の保管に。ノートには入れない
        const until = new Date(Date.now() + KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
        for (const v of vols) {
          mkdirSync(path.dirname(bodyPath(v.sha256)), { recursive: true, mode: 0o700 });
          writeFileSync(bodyPath(v.sha256), JSON.stringify({ sha256: v.sha256, text: v.text, for: v.for ?? null, date: v.date ?? null, contract, until, kept_at: nowZ() }, null, 1), { mode: 0o600 });
        }
        const kept = vols.map((v) => ({ sha256: v.sha256, for: v.for ?? null }));
        mark(keeps, contract, "kept", { sha256: kept[0].sha256, for: kept[0].for, until, volumes: kept });
        jlog(contract, "body", `ok ${kept.length} 冊 until=${until} 先頭 sha256=${kept[0].sha256.slice(0, 16)}`);
        await writeIndex(me, keeps);
      }
      if (k.stage === "kept") {
        // 7. keep の納品
        if (Date.now() >= k.refundAfterMs) { mark(keeps, contract, "late"); jlog(contract, "keep", "gave up: refundAfterMs passed"); continue; }
        // 棚ごとの契約なら volumes を並べる。1 冊なら前の形のまま（決定 34-2）
        const many = Array.isArray(k.volumes) && k.volumes.length > 1;
        const line = hakoLine(many
          ? { t: "keep", contract, volumes: k.volumes, until: k.until, how: `recall on /r/${BOARD_ROOM}`, nonce: randomBytes(8).toString("hex") }
          : { t: "keep", contract, sha256: k.sha256, for: k.for, until: k.until, how: `recall on /r/${BOARD_ROOM}`, nonce: randomBytes(8).toString("hex") });
        await post(me, k.room, line, { gateUntilMs: k.claimByMs, onGateWait: (n) => jlog(contract, "keep", `gate busy, retry ${n}`) });
        mark(keeps, contract, "delivered");
        jlog(contract, "keep", `ok ${many ? `${k.volumes.length} 冊` : `sha256=${k.sha256.slice(0, 16)}`} until=${k.until}`);
      }
      if (k.stage === "delivered") {
        if (Date.now() >= k.refundAfterMs) { mark(keeps, contract, "late"); jlog(contract, "reveal", "gave up: refundAfterMs passed"); continue; }
        const reveal = { type: "reveal", from: me.did, contract, ref: k.lock_ref, secret: k.preimage };
        await post(me, k.room, reveal, { gateUntilMs: k.claimByMs, onGateWait: (n) => jlog(contract, "reveal", `gate busy, retry ${n}`) });
        mark(keeps, contract, "revealed");
        jlog(contract, "reveal", "ok。あとは client の receipt");
        try { await rail.claim(k.lock_ref, k.preimage); } catch (e) { jlog(contract, "rail-claim", `skip ${e.message}`); }
        try { const sn = stateNote(contract); await notes.set(sn.ns, sn.key, stateNoteValue("claimed", k.lock_ref), { if: stateNoteValue("locked", k.lock_ref) }); }
        catch (e) { jlog(contract, "state-note", `skip ${e.message}`); }
        await writeIndex(me, keeps);
      }
    } catch (e) {
      jlog(contract, k.stage, e.gate ? `gave up: gate busy until claimByMs (${e.message})` : `error ${e.message}`);
    }
  }

  // 8. recall に応える
  await serveRecalls(me, keeps);
}

// ── 本体 ──
function readSavedBoard(target) {
  const rows = [];
  for (const f of (existsSync(target) ? readSavedExport(target).rows : [])) rows.push(f);
  return parseJoins(rows);
}
if (DRY_RUN) {
  let myDid = null;
  if (process.env.TC_PASS) { try { myDid = loadSigner(KEY_PATH, process.env.TC_PASS).did; } catch { myDid = null; } }
  const target = EXPORT_ARG ?? path.join(homedir(), "hako_export", OFFER_ROOM);
  const exp = readSavedExport(target);
  const boardDir = BOARD_ARG ?? path.join(homedir(), "hako_export", BOARD_ROOM);
  let board = { joined: new Map(), stats: { bad_sig: 0 } };
  try { board = parseJoins(readSavedExport(boardDir).rows); } catch { log("", `  board ${boardDir} が読めない: join 済み DID は 0 として判定`); }
  const allFrames = decodeAll(exp.rows);
  const found = candidates(allFrames, allFrames, myDid, {}, Date.now(), board.joined,
    (seq, f, fails) => log("", `  skip seq ${seq}  job ${f.job.id}  amount ${f.amount} — ${failText(fails)}`));
  const keepOffers = allFrames.filter((x) => x.frame.type === "offer" && String(x.frame.job?.id ?? "").startsWith(JOB_PREFIX));
  log("", `dry-run  export ${target}  rows ${exp.rows.length}  frames ${allFrames.length}  ${JOB_PREFIX}* offers ${keepOffers.length}  candidates ${found.length}  joined ${board.joined.size}${myDid ? "" : "  (own-offer check skipped: no key)"}`);
  for (const { seq, offer } of found) log("", `  seq ${seq}  job ${offer.job.id}  amount ${offer.amount}  expires ${iso(offer.expiresMs)}`);
  const keeps = readJson(KEEPS_PATH, {});
  log("", `state    keeps ${Object.keys(keeps).length} 件 ${JSON.stringify(Object.fromEntries(Object.entries(keeps).map(([c, k]) => [c.slice(0, 18), `${k.job} ${k.stage}`])))}`);
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
log("", `keeper ${me.did}`);
log("", `keep   min ${MIN_AMOUNT} PAPER   ${KEEP_DAYS} days   every ${INTERVAL_SEC}s   state ${STATE_DIR}`);
for (;;) {
  try { await step(me); } catch (e) { jlog("-", "round", `error ${e.message}`); }
  if (ONCE) break;
  await sleep(INTERVAL_SEC * 1000);
}

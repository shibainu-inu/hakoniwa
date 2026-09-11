#!/usr/bin/env node
// hako_client.mjs — 箱庭の運営 client（自宅 …PvqA）。ルール v0.7「動き方」の client の行を 1 周にしたもの。
// 「あなたの今日の日記を書いて」の offer を、席にいる worker の数ぶん（1 日 20 本まで）出し、accept を運営以外の worker から先に lock し、
// 届いた diary を worker のノートの数字で確かめて receipt する。土台は v0.6 の hako_client.mjs（hako_test_payer.mjs）。
// 用法: read -s TC_PASS && export TC_PASS   # パスフレーズは端末に打つ。コマンド行に書かない
//       node hako_client.mjs                # 5 分ごとに表を見る（HAKO_CLIENT_INTERVAL_SEC で変更）
//       node hako_client.mjs --once         # 1 周だけ手回し
//       node hako_client.mjs --dry-run      # 出す offer、lock 候補、契約の段を表示するだけ（投稿しない。鍵が無ければ EXPECT_DID で自分の DID を渡す）
// 環境変数: KEY_PATH (既定 ~/did_key.json), TCLK_DIR, TECHNOCORE_URL, HAKO_STATS (既定 ~/hako_stats/latest.json。席の状態と運営 DID の一覧を読む),
//   HAKO_DIARY_PRICE (日記代、既定 400), HAKO_CLIENT_EXPIRES_MIN / _CLAIMBY_MIN / _REFUND_MIN (既定 360 / 720 / 1440 分),
//   HAKO_CLIENT_INTERVAL_SEC (既定 300), HAKO_CLIENT_MAX_PER_DAY (1 日に lock する日記の上限、既定 20 = ルールと会場の「1 IP 1 日 20 部屋」),
//   HAKO_CLIENT_MAX_OPEN (同時に開けておく offer の上限、既定 5), HAKO_CLIENT_OPERATOR_WAIT_MIN (運営 worker の accept を lock するまで待つ分、既定 30),
//   HAKO_CLIENT_STATE (既定 ~/.hako_client), HAKO_CLIENT_LOG (既定 ~/hako_client.log), HAKO_RULES_PY (既定 ./hako_rules.py),
//   HAKO_CLIENT_TEST=1 (job.id に -test- を入れる。fold は別集計する), EXPECT_DID
//
// 1 周ですること（状態は state/days.json、0600。日付 YYYYMMDD がキー、その下は job.id ごと）:
//   1. 掲示板の join、/r/tclk-offers の export、fold の出力（HAKO_STATS: did の state / operator、box.operators）を読む
//   2. 今日（UTC）の「働ける worker」= join 済みで worker 役、自分以外、fold の state が seated（fold にまだ無い DID は seated 扱い）、今日まだ lock していない。
//      開いている offer（accept 待ち）が働ける worker の数に足りず、今日の lock ＋ 開いている offer が上限（20）未満なら、通し番号を進めて日記 offer を出す
//      （role payer、hash lock、PAPER、paper、job.id は hakoniwa-diary-<末尾 4 文字>-<YYYYMMDD>-<通し番号>、job.context は無し。数字のノートは worker が置く）。
//      expiresMs を過ぎて lock できる accept が無ければ同じ job.id で出し直す（決定 1 ①）
//   3. offer への accept のうち、join 済み・worker 役・自分以外・contract 再計算一致・fold で seated・今日まだ lock していない worker のものを、
//      運営以外（stats の box.operators に無い DID）を先に seq 順で 1 件 lock する。運営の worker の accept は、offer を出してから
//      HAKO_CLIENT_OPERATOR_WAIT_MIN 分の間に運営以外の accept が無いときだけ lock する（門の再送は claimByMs まで）
//   4. 取引の部屋に worker の diary と reveal が届いたら、worker のノート /kv/hakoniwa-<worker 末尾 8 小文字>/diary-<YYYYMMDD> の 5 値で
//      hako_rules.py check-diary（条件 2 の for は worker、条件 4 はそのノート）と sha256 を確かめる。合格なら receipt。
//      不合格なら理由をローカル log に残し、refundAfterMs 後に refund。reveal が無いまま refundAfterMs を過ぎても refund
//   5. 開いている offer を自分のノート /kv/hakoniwa-<末尾 8 小文字>/open に 1 行 JSON で置く {"date","open":[{"seq","frame"}]}。
//      入口 v2（ブラウザの worker）はこれを読んで受ける（/r/tclk-offers の export は重いので）。
//      「開いている」は自分の台帳 state/offers.json（offer ごとに id・出した時刻・期限・lock 済みか）で決める: 今日の offer で、期限内 かつ 未 lock。
//      export は accept の検出と seq の記入にだけ使う（export は保持された ring で、tclk-offers は 40〜60 分で流れる。2026-09-11 に open が空になった）
//   6. 1 件ごとに log に 1 行（時刻、契約先頭 16、段階、結果）
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchJoins, hasRole } from "./hako_board.mjs";
import { BOX, OFFER_ROOM, jobPrefix, noteNs } from "./hako_box.mjs";
import {
  core, BASE, log, sleep, nowZ, fileLog, setLogFile, loadSigner, req, readTail, post, notes, fetchExport,
  readJson, saveJson, decodeAll, indexAccepts, sha256Utf8, contextPath,
} from "./hako_common.mjs";

const {
  PaperRail, applyFrame, contractId, dealRoom, lockTerms, makeOffer, openContract, stateNote, stateNoteValue, tryDecodeFrame,
} = core;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY_PATH = process.env.KEY_PATH ?? path.join(homedir(), "did_key.json");
const STATS = process.env.HAKO_STATS ?? path.join(homedir(), "hako_stats", "latest.json");
const PRICE = String(process.env.HAKO_DIARY_PRICE ?? BOX.diary_price);          // 数字と名前の既定は hako_box.json（決定 16）。env で上書き
const EXPIRES_MIN = Number(process.env.HAKO_CLIENT_EXPIRES_MIN ?? 360);
const CLAIMBY_MIN = Number(process.env.HAKO_CLIENT_CLAIMBY_MIN ?? 720);
const REFUND_MIN = Number(process.env.HAKO_CLIENT_REFUND_MIN ?? 1440);
const INTERVAL_SEC = Number(process.env.HAKO_CLIENT_INTERVAL_SEC ?? BOX.client_interval_sec);
const MAX_PER_DAY = Number(process.env.HAKO_CLIENT_MAX_PER_DAY ?? BOX.client_max_per_day);
const MAX_OPEN = Number(process.env.HAKO_CLIENT_MAX_OPEN ?? 5);
const OPERATOR_WAIT_MIN = Number(process.env.HAKO_CLIENT_OPERATOR_WAIT_MIN ?? BOX.operator_wait_min);
const STATE_DIR = process.env.HAKO_CLIENT_STATE ?? path.join(homedir(), ".hako_client");
const LOG_PATH = process.env.HAKO_CLIENT_LOG ?? path.join(homedir(), "hako_client.log");
const RULES_PY = process.env.HAKO_RULES_PY ?? path.join(HERE, "hako_rules.py");
const TEST = process.env.HAKO_CLIENT_TEST === "1";
const argv = process.argv.slice(2);
const ONCE = argv.includes("--once");
const DRY_RUN = argv.includes("--dry-run");
const NUM_KEYS = ["earn", "spend", "balance", "mem_bytes", "life_days"];   // fold の出力名（README「fold の出力」で固定）
const OPEN_STAGES = ["offering", "offered"];                                 // accept 待ち
const LOCKED_STAGES = ["locking", "locked", "claimed", "rejected", "refunded"];   // 今日の lock として数える（lock を出した = 部屋を作った）

function jlog(contract, stage, result) {
  const line = `${nowZ()} ${String(contract).slice(0, 16)} ${stage} ${result}`;
  console.log(line);
  if (!DRY_RUN) fileLog(LOG_PATH, line);
}
const DAYS_PATH = path.join(STATE_DIR, "days.json");
const loadDays = () => readJson(DAYS_PATH, {});
const saveDays = (d) => { if (!DRY_RUN) saveJson(DAYS_PATH, d, 0o600); };
// ── 台帳 state/offers.json: offer ごと {id, job, date, offered_at, offered_at_ms, expiresMs, claimByMs, seq, frame, locked, locked_at?, contract?} ──
// days.json（job.id ごとの段）から毎周写す。「開いている」= 今日の offer で 期限内 かつ 未 lock。live の export に見えるかどうかは見ない
const OFFERS_PATH = path.join(STATE_DIR, "offers.json");
const LEDGER_KEEP_MS = 2 * 86_400_000;                                      // 期限から 2 日過ぎた行は捨てる
const loadLedger = () => readJson(OFFERS_PATH, {});
const saveLedger = (l) => { if (!DRY_RUN) saveJson(OFFERS_PATH, l, 0o600); };
function ledgerSync(ledger, date8, jobs, seqOf, now) {
  for (const j of Object.values(jobs)) {
    const o = j.offer;
    const e = (ledger[o.id] ??= { id: o.id, job: j.job, date: date8, offered_at: iso(j.offered_at_ms), offered_at_ms: j.offered_at_ms,
      expiresMs: o.expiresMs, claimByMs: o.claimByMs, seq: j.adopted_seq ?? null, frame: o, locked: false });
    if (e.seq === null && seqOf.has(o.id)) e.seq = seqOf.get(o.id);
    const locked = LOCKED_STAGES.includes(j.stage) || j.stage === "gate_closed";   // lock を出した（着地不明・門で断念も含む）
    if (locked && !e.locked) { e.locked = true; e.locked_at = nowZ(); e.contract = j.contract ?? null; }
    if (!locked && e.locked) { e.locked = false; delete e.locked_at; delete e.contract; }   // locking → 着地せず offered に戻った
  }
  for (const [id, e] of Object.entries(ledger)) if (now - Number(e.expiresMs) > LEDGER_KEEP_MS) delete ledger[id];
}
const ledgerOpen = (ledger, date8, now) => Object.values(ledger)
  .filter((e) => e.date === date8 && !e.locked && now < e.expiresMs)
  .sort((a, b) => a.offered_at_ms - b.offered_at_ms)
  .map((e) => ({ seq: e.seq, frame: e.frame }));
const short = (did) => "…" + String(did).slice(-5);
const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : String(ms));
const today8 = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");
const jobPrefixFor = (did, date8) => `${jobPrefix("diary")}${did.slice(-4)}${TEST ? "-test" : ""}-${date8}-`;

// ── fold の出力: 席の状態と運営 DID ──
function readStats() {
  const stats = readJson(STATS, null);
  if (!stats) return { ok: false, operators: new Set(), stateOf: () => "seated", generated: null };
  const operators = new Set(Array.isArray(stats.box?.operators) ? stats.box.operators : []);
  const did = stats.did ?? {};
  return { ok: true, operators, generated: stats.box?.generated ?? null,
    stateOf: (d) => (did[d] ? (did[d].state ?? "seated") : "seated") };   // fold にまだ無い DID（入ったばかり）は seated 扱い
}

// ── 2. 働ける worker ──
function eligibleWorkers(joined, st, myDid, lockedWorkers) {
  const out = [];
  for (const [d, e] of joined) {
    if (d === myDid || !hasRole(e, "worker")) continue;
    if (st.stateOf(d) !== "seated") continue;
    if (lockedWorkers.has(d)) continue;
    out.push(d);
  }
  return out;
}

// ── 3. lock する accept を選ぶ（運営以外を先に、seq 順。運営 worker は OPERATOR_WAIT_MIN 分待つ） ──
function chooseAccept(offer, offeredAtMs, accs, joined, st, myDid, lockedWorkers, now) {
  const why = [];
  const ok = [];
  for (const a of accs.slice().sort((x, y) => x.seq - y.seq)) {
    const f = a.frame, e = joined.get(a.from);
    const reasons = [];
    if (!e) reasons.push("join していない"); else if (!hasRole(e, "worker")) reasons.push(`役に worker が無い [${e.roles.join(",")}]`);
    if (a.from === myDid) reasons.push("自分");
    if (a.from !== f.from) reasons.push("署名者と from が違う");
    if (st.stateOf(a.from) !== "seated") reasons.push(`席にいない (${st.stateOf(a.from)})`);
    if (lockedWorkers.has(a.from)) reasons.push("今日すでに lock した worker");
    const expect = contractId(offer, { from: f.from, ref: f.ref, statement: f.statement, paymentKey: f.paymentKey, nonce: f.nonce });
    if (expect !== f.contract) reasons.push("contract id 不一致");
    const op = st.operators.has(a.from);
    if (reasons.length === 0) ok.push({ a, op });
    why.push(`seq ${a.seq} ${short(a.from)}${op ? " (運営)" : ""}: ${reasons.length ? reasons.join(", ") : "可"}`);
  }
  const participant = ok.find((x) => !x.op);
  if (participant) return { chosen: participant.a, why };
  const operator = ok.find((x) => x.op);
  if (operator) {
    const waitUntil = offeredAtMs + OPERATOR_WAIT_MIN * 60_000;
    if (now >= waitUntil) return { chosen: operator.a, why };
    why.push(`運営 worker の accept は ${iso(waitUntil)} まで待つ`);
  }
  return { chosen: null, why };
}

// ── 4. 合格条件（hako_rules.py check-diary。不合格のとき exit 1 を返すので exit code では判断しない） ──
function checkDiary(diary, ctxValues, client, date8, worker, meta) {
  const inp = JSON.stringify({ diary, context: ctxValues, client, date: date8, worker, meta });
  const r = spawnSync("python3", [RULES_PY, "check-diary", "-"], { input: inp, encoding: "utf8" });
  const out = String(r.stdout ?? "").trim().split("\n").pop();
  if (!out) throw new Error(`check-diary produced no output (${(r.stderr ?? "").trim().slice(0, 120)})`);
  return JSON.parse(out);
}
async function workerNote(worker, date8) {
  const p = contextPath(worker, "diary", date8);
  const [, ns, key] = p.match(/^\/kv\/([^/]+)\/([^/]+)$/);
  const raw = await notes.get(ns, key).catch(() => null);
  if (raw === null) return { path: p, ctx: null };
  try { const c = JSON.parse(raw); return { path: p, ctx: c && typeof c === "object" ? c : null }; } catch { return { path: p, ctx: null }; }
}

function newOffer(myDid, jobId, t) {
  return makeOffer({
    from: myDid, role: "payer", lock: "hash", amount: PRICE, asset: "PAPER", rails: ["paper"],
    expiresMs: t + EXPIRES_MIN * 60_000, claimByMs: t + CLAIMBY_MIN * 60_000, refundAfterMs: t + REFUND_MIN * 60_000,
    job: { proto: "hakoniwa", id: jobId },                    // 数字のノートは worker が置くので context は無し（ルール v0.7「出す側」）
  });
}

// ── 1 周 ──
async function step(me) {
  const myDid = me.did;
  const days = loadDays();
  const date8 = today8();
  const prefix = jobPrefixFor(myDid, date8);
  const board = await fetchJoins(BASE, req);
  const exp = await fetchExport(OFFER_ROOM);
  const allFrames = decodeAll(exp.rows);
  const accepted = indexAccepts(allFrames);
  const st = readStats();
  const rail = new PaperRail(notes);
  const now = Date.now();
  if (days[date8] && !days[date8].jobs) {                  // v0.6 の state（1 日 1 本、job.id ごとでない）→ v0.7 の形に移す（通し番号 0）
    const o = days[date8];
    days[date8] = { date: date8, serial: 0, jobs: o.job ? { [o.job]: { ...o, n: 0, offered_at_ms: (o.offer?.expiresMs ?? Date.now()) - EXPIRES_MIN * 60_000, migrated: true } } : {} };
    saveDays(days);
    jlog(o.contract ?? o.offer?.id ?? "-", "state", `migrated v0.6 day state (${o.job} ${o.stage})`);
  }
  const day = (days[date8] ??= { date: date8, serial: 0, jobs: {} });
  const jobs = day.jobs;

  // 1'. state に無くても export に今日の自分の offer があれば（state を失った）、それを引き継ぐ
  for (const x of allFrames) {
    const f = x.frame;
    if (f.type !== "offer" || x.from !== myDid || !String(f.job?.id ?? "").startsWith(prefix)) continue;
    const jobId = f.job.id;
    const n = Number(jobId.slice(prefix.length));
    if (Number.isFinite(n) && n > day.serial) day.serial = n;
    const j = jobs[jobId];
    if (j && (j.offer.id === f.id || j.offer.expiresMs > f.expiresMs)) continue;   // 知っている、または知っている方が新しい
    jobs[jobId] = { job: jobId, n, offer: f, offered_at_ms: Date.parse(x.ts), offers: (j?.offers ?? 0) + 1, stage: "offered", updated: nowZ(), adopted_seq: x.seq };
    jlog(f.id, "offer", `adopted from export (seq ${x.seq}, ${j ? "newer than state" : "state was missing"})`);
  }
  saveDays(days);

  const lockedWorkers = new Set(Object.values(jobs).filter((j) => LOCKED_STAGES.includes(j.stage) || j.stage === "gate_closed").map((j) => j.worker).filter(Boolean));
  const lockedToday = Object.values(jobs).filter((j) => LOCKED_STAGES.includes(j.stage)).length;
  const open = Object.values(jobs).filter((j) => OPEN_STAGES.includes(j.stage));
  const workers = eligibleWorkers(board.joined, st, myDid, lockedWorkers);
  jlog("-", "round", `joined ${board.joined.size} eligible workers ${workers.length} [${workers.map(short).join(" ")}] open ${open.length} locked today ${lockedToday}/${MAX_PER_DAY}`
    + (st.ok ? ` stats ${st.generated} operators ${st.operators.size}` : ` stats missing (${STATS}): everyone treated as seated participant`));

  // 2. 開いている offer が働ける worker の数に足りなければ、通し番号を進めて出す（上限: 1 日 MAX_PER_DAY、同時 MAX_OPEN）
  let toOpen = Math.min(workers.length - open.length, MAX_PER_DAY - lockedToday - open.length, MAX_OPEN - open.length);
  for (; toOpen > 0; toOpen--) {
    day.serial += 1;
    const jobId = `${prefix}${day.serial}`;
    const offer = newOffer(myDid, jobId, Date.now());
    if (DRY_RUN) { log("", `dry-run: offer を出す  job ${jobId}  amount ${PRICE}  expires ${iso(offer.expiresMs)}  claimBy ${iso(offer.claimByMs)}`); continue; }
    jobs[jobId] = { job: jobId, n: day.serial, offer, offered_at_ms: Date.now(), offers: 1, stage: "offering", updated: nowZ() };
    saveDays(days);
    await post(me, OFFER_ROOM, offer);
    jobs[jobId].stage = "offered"; jobs[jobId].updated = nowZ(); saveDays(days);
    jlog(offer.id, "offer", `ok ${jobId} amount=${PRICE} expires=${iso(offer.expiresMs)}`);
  }

  // 2'〜4. job ごとに進める
  for (const j of Object.values(jobs).sort((a, b) => a.n - b.n)) {
    try { await advance(me, days, day, j, { allFrames, accepted, board, st, rail, lockedWorkers, date8 }); }
    catch (e) { jlog(j.contract ?? j.offer.id, "round", `error ${e.message}`); }
  }

  // 5. 開いている offer を台帳から選んでノートに（入口 v2 が読む）。export は seq を埋めるだけ
  const seqOf = new Map(allFrames.filter((x) => x.frame.type === "offer" && x.from === myDid).map((x) => [x.frame.id, x.seq]));
  const ledger = loadLedger();
  ledgerSync(ledger, date8, jobs, seqOf, Date.now());
  saveLedger(ledger);
  const openNow = ledgerOpen(ledger, date8, Date.now());
  const openValue = JSON.stringify({ date: date8, open: openNow });
  if (DRY_RUN) log("", `dry-run: 台帳 ${Object.keys(ledger).length} 件、開いている offer ${openNow.length} 件 [${openNow.map((o) => `${o.frame.job.id}${o.seq === null ? "" : ` seq ${o.seq}`}`).join(", ")}]`);
  if (!DRY_RUN && openValue !== day.open_note) {
    const ns = noteNs(myDid);
    try { if (await notes.set(ns, "open", openValue)) { day.open_note = openValue; saveDays(days); jlog("-", "open-note", `ok ${openNow.length} open offer(s)`); } }
    catch (e) { jlog("-", "open-note", `fail ${e.message}`); }
  }
}

async function advance(me, days, day, j, c) {
  const myDid = me.did;
  const offer = j.offer;
  const now = Date.now();

  if (j.stage === "offering") {                              // 投稿の着地が不明
    const landed = c.allFrames.some((x) => x.frame.type === "offer" && x.frame.id === offer.id);
    if (!landed) { delete day.jobs[j.job]; day.serial = Math.max(0, day.serial - (j.n === day.serial ? 1 : 0)); saveDays(days); jlog(offer.id, "offer", "not landed; will offer again next round"); return; }
    j.stage = "offered"; j.updated = nowZ(); saveDays(days); jlog(offer.id, "offer", "landed (seen in export)");
  }

  if (j.stage === "offered") {
    const { chosen, why } = chooseAccept(offer, j.offered_at_ms, c.accepted.get(offer.id) ?? [], c.board.joined, c.st, myDid, c.lockedWorkers, now);
    if (DRY_RUN) { log("", `dry-run: ${j.job} lock 候補 ${chosen ? `seq ${chosen.seq} ${short(chosen.from)} contract ${chosen.frame.contract.slice(0, 18)}…` : "なし"}  (${why.join(" | ") || "accept なし"})`); return; }
    if (chosen === null) {
      if (why.length) jlog(offer.id, "accept", `${j.job}: none to lock yet (${why.join(" | ")})`);
      if (now >= offer.claimByMs) { j.stage = "no_worker"; j.updated = nowZ(); saveDays(days); jlog(offer.id, "accept", `${j.job}: gave up, claimByMs passed`); return; }
      if (now >= offer.expiresMs && !(c.accepted.get(offer.id) ?? []).length) {   // 決定 1 ①: 期限切れで accept 無しなら同じ job.id で出し直す
        const again = newOffer(myDid, j.job, now);
        Object.assign(j, { offer: again, offered_at_ms: now, offers: (j.offers ?? 1) + 1, stage: "offering", updated: nowZ() }); saveDays(days);
        await post(me, OFFER_ROOM, again);
        j.stage = "offered"; j.updated = nowZ(); saveDays(days);
        jlog(again.id, "offer", `${j.job}: re-offered (expired without accept; #${j.offers})`);
      }
      return;
    }
    const contract = chosen.frame.contract;
    const room = dealRoom(contract);
    const stepA = applyFrame(openContract(offer), chosen.frame, Date.parse(chosen.ts));
    if (!stepA.ok) { jlog(contract, "accept", `cannot apply accept: ${stepA.reason}`); return; }
    // すでに自分の lock が部屋にあれば（state を失っていた）出し直さない
    const already = (await readTail(room).catch(() => [])).some((m) => m.from === myDid && tryDecodeFrame(String(m.text ?? ""))?.type === "lock");
    let ref;
    const existing = await c.rail.read(contract).catch(() => null);
    if (existing && existing.statement === chosen.frame.statement) ref = contract;
    else ref = await c.rail.lock(lockTerms(stepA.state));
    const lockFrame = { type: "lock", from: myDid, contract, rail: "paper", ref };
    Object.assign(j, { contract, room, worker: chosen.from, accept: chosen.frame, accepted_at_ms: Date.parse(chosen.ts), lock: lockFrame, stage: already ? "locked" : "locking", updated: nowZ() });
    c.lockedWorkers.add(chosen.from);
    saveDays(days);
    jlog(contract, "accept", `${j.job}: chose ${short(chosen.from)}${c.st.operators.has(chosen.from) ? " (運営)" : ""} seq ${chosen.seq} (${why.join(" | ")})`);
    if (already) { jlog(contract, "lock", "already in room (state was missing)"); return; }
    try {
      await post(me, room, lockFrame, { gateUntilMs: offer.claimByMs, onGateWait: (n) => jlog(contract, "lock", `gate busy, retry ${n}`) });
    } catch (e) {
      if (e.gate) { j.stage = "gate_closed"; j.updated = nowZ(); saveDays(days); jlog(contract, "lock", "gave up: claimByMs passed while gate busy"); return; }
      throw e;
    }
    j.stage = "locked"; j.updated = nowZ(); saveDays(days);
    jlog(contract, "lock", `ok room ${room}`);
    try { const sn = stateNote(contract); await notes.set(sn.ns, sn.key, stateNoteValue("locked", ref), { if: stateNoteValue("accepted") }); } catch { /* 参考情報 */ }
    return;
  }
  if (DRY_RUN) { log("", `dry-run: ${j.job} 契約 ${j.contract?.slice(0, 18)}… は ${j.stage}（worker ${short(j.worker)}）`); return; }
  if (j.stage === "locking") {                               // lock の着地が不明
    const msgs = await readTail(j.room).catch(() => []);
    const landed = msgs.some((m) => m.from === myDid && tryDecodeFrame(String(m.text ?? ""))?.type === "lock");
    j.stage = landed ? "locked" : "offered"; j.updated = nowZ(); saveDays(days);
    jlog(j.contract, "lock", landed ? "landed (seen in room)" : "not landed; will lock again");
    if (!landed) return;
  }

  // 4. diary と reveal → 合格条件（worker のノート） → receipt / refund
  if (j.stage === "locked") {
    const contract = j.contract;
    const msgs = await readTail(j.room);
    let diary = null, diarySeq = null, reveal = null, revealSeq = null;
    for (const m of msgs) {
      const text = String(m.text ?? "");
      if (m.from !== j.worker) continue;
      if (diary === null && text.startsWith("hakoniwa/0 ")) {
        try { const h = JSON.parse(text.slice(11)); if (h.t === "diary" && h.contract === contract) { diary = h; diarySeq = m.seq; } } catch { /* skip */ }
      }
      const f = tryDecodeFrame(text);
      if (f && f.type === "reveal" && f.contract === contract && reveal === null) { reveal = f; revealSeq = m.seq; }
    }
    if (reveal === null) {
      if (now >= offer.refundAfterMs) {
        await post(me, j.room, { type: "refund", from: myDid, contract, ref: j.lock.ref });
        j.stage = "refunded"; j.updated = nowZ(); saveDays(days);
        jlog(contract, "refund", `no reveal by refundAfterMs (diary=${diary !== null})`);
      }
      return;
    }
    const view = applyFrame(openContract(offer), j.accept, j.accepted_at_ms).state;
    const stepL = applyFrame(view, j.lock, j.accepted_at_ms + 1);
    const stepR = stepL.ok ? applyFrame(stepL.state, reveal, now) : stepL;
    if (!stepR.ok || stepR.state.status !== "claimed") { jlog(contract, "reveal", `rejected: ${stepR.reason}; retry next round`); return; }
    const wn = await workerNote(j.worker, c.date8);
    const ctxValues = NUM_KEYS.map((k) => (wn.ctx && wn.ctx[k] !== undefined ? wn.ctx[k] : null));
    const meta = { signer: j.worker, room: j.room, deal_room: j.room, before_reveal: diary !== null && diarySeq < revealSeq };
    const r = checkDiary(diary ?? {}, ctxValues, myDid, c.date8, j.worker, meta);
    const shaOk = diary !== null && typeof diary.text === "string" && sha256Utf8(diary.text) === diary.sha256;
    j.diary = diary; j.diary_check = { ...r, sha256_ok: shaOk, worker_note: wn.path, worker_note_found: wn.ctx !== null };
    if (r.ok === true && shaOk) {
      await post(me, j.room, { type: "receipt", from: myDid, contract, outcome: "claimed", rail: "paper", ref: j.lock.ref });
      j.stage = "claimed"; j.updated = nowZ(); saveDays(days);
      jlog(contract, "receipt", `ok worker=${short(j.worker)} text=${diary.text}`);
      return;
    }
    if (r.ok === null) { jlog(contract, "diary", `undecided: ${r.reason} (worker note ${wn.path} ${wn.ctx ? "read" : "not found"}); retry next round until ${iso(offer.refundAfterMs)}`); if (now < offer.refundAfterMs) return; }
    j.stage = "rejected"; j.updated = nowZ(); saveDays(days);
    // 落ちた理由はローカルの log にだけ残す（部屋には書かない。ルール「日記の合格条件」）
    jlog(contract, "diary", `rejected: ${r.reason || (shaOk ? "" : "sha256 mismatch")} (checks ${JSON.stringify(r.checks)}); refund at ${iso(offer.refundAfterMs)}`);
  }
  if (j.stage === "rejected" && now >= offer.refundAfterMs) {
    await post(me, j.room, { type: "refund", from: myDid, contract: j.contract, ref: j.lock.ref });
    j.stage = "refunded"; j.updated = nowZ(); saveDays(days);
    jlog(j.contract, "refund", "ok (diary rejected)");
  }
}

// ── 本体 ──
let me;
if (process.env.TC_PASS) {
  me = loadSigner(KEY_PATH, process.env.TC_PASS);
  if (process.env.EXPECT_DID && process.env.EXPECT_DID !== me.did) { console.error(`鍵から導出したDIDが期待値と不一致: ${me.did}`); process.exit(2); }
} else if (DRY_RUN && process.env.EXPECT_DID) {
  me = { did: process.env.EXPECT_DID };                      // 表示だけなので署名しない
} else {
  console.error(DRY_RUN ? "--dry-run には TC_PASS か EXPECT_DID（自分の DID）が要ります" : "TC_PASS(パスフレーズ)が未設定です"); process.exit(2);
}
if (!DRY_RUN) { mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }); setLogFile(LOG_PATH); }
log("", `venue  ${BASE}`);
log("", `client ${me.did}${TEST ? "  (TEST: job.id に -test-)" : ""}${DRY_RUN ? "  (dry-run: 投稿しない)" : ""}`);
log("", `price ${PRICE} PAPER   expires ${EXPIRES_MIN}m claimBy ${CLAIMBY_MIN}m refundAfter ${REFUND_MIN}m   per day ${MAX_PER_DAY}  open ${MAX_OPEN}  operator wait ${OPERATOR_WAIT_MIN}m   every ${INTERVAL_SEC}s   stats ${STATS}`);
for (;;) {
  try { await step(me); } catch (e) { jlog("-", "round", `error ${e.message}`); }
  if (ONCE || DRY_RUN) break;
  await sleep(INTERVAL_SEC * 1000);
}

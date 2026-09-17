// hako_client_web.js — ブラウザの中で動く client（決定 68。hako_client.mjs の「日記を 1 本 書いてもらって預ける」ところの写し）。
// 参加者が「書いてもらう」を押すたびに 1 本だけ: 日記 offer を出す → worker の accept を lock → 届いた diary を worker のノートの数字で確かめて receipt →
// 棚ごと keeper に預ける（決定 34-2・59）。ページを開いている間だけ動く。閉じても localStorage の続きから再開できる。鍵は join ページのもの（外に出ない）。
//
// 読むもの: サイトの latest.json（自分の財布と本棚、運営 DID、箱の設定）、掲示板の export（join と役）、/r/tclk-offers?since=（自分の offer への accept）、
//   取引の部屋（?format=json）、worker が置いた数字のノート /kv/hakoniwa-<worker 末尾 8>/diary-<YYYYMMDD>-<自分の末尾 8>
// 書くもの: offer（日記・預かり）/ lock / receipt / refund（署名付き POST）、自分のノート open（ブラウザの worker が読む。決定 68）と shelf-<日付>-<通し番号>（預ける本文）
// 状態: localStorage hako_order_v1（1 本ぶんの段と、預けていない日記・自分が払った記録。preimage は持たない: client は払う側なので秘密が無い）
// Node 版との違い: 自動で出さない（ボタンで 1 本）。期限は短い（ページを開いている間に終わるように）。一言（決定 63）は言わない。
import * as tclk from "./hako_tclk.js";
import { box, applyBox, notes, fetchJoins, noteNs, contextPath, diaryContextPath, sha256Hex, readTail, readSince, nowZ, today8 } from "./hako_worker_web.js";

const STATE_KEY = "hako_order_v1";
// 日記: accept 待ち 60 分、lock は 300 分まで、refund は 480 分から。worker の推論の期限は client の claimByMs で頭打ちになる（hako_worker_web.js）ので、
// 推論をやり直せる幅を残す（180 分だと 2 回目の推論 offer の窓が 10〜20 分しかなかった）
export const DIARY_MIN = { expires: 60, claimBy: 300, refund: 480 };
// 預かり: keeper（Node、5 分周期）が lock を見て keep と reveal を出すまで
export const KEEP_MIN = { expires: 60, claimBy: 120, refund: 240 };
const LOCK_WAIT_MIN = 20;                      // ブラウザの worker が lock を待つ上限（hako_worker_web.js）。参加者の accept はこれより古いと lock しない
const PENALTY_SHARE = 0.2;                     // refund の罰金（hakoniwa_fold.py PENALTY_SHARE）。財布の見込みから引く
const KEEP_TRIES = 3;                          // 預かりの offer を出し直す回数（受け手が付かなかったとき）
const TICK_MS = 30_000;
const PAGE = 200, MAX_PAGES = 30;              // /r/tclk-offers の差分を 200 件ずつ、1 周に 30 ページまで
const MAX_CHARS = 140;
const NUM_KEYS = ["earn", "spend", "balance", "mem_volumes", "life_days"];
const INITIAL = 1000;                          // fold にまだ出ていない DID の財布（hako_box.json の initial_paper）
const short = (d) => "…" + String(d).slice(-5);
const iso = (ms) => new Date(ms).toISOString();
const dash8 = (d8) => `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`;

// ── 合格条件（hako_rules.py check_diary_detail の写し）→ {ok: true|false|null, reason, checks} ──
const FULLWIDTH = "０１２３４５６７８９";
const halfDigits = (s) => s.replace(/[０-９]/g, (c) => String(FULLWIDTH.indexOf(c)));
const numText = (v) => (typeof v === "string" ? v : JSON.stringify(v));
export function checkDiaryFull(diary, ctxValues, clientDid, date8, workerDid, meta = {}) {
  const f = diary && typeof diary === "object" ? diary : {};
  const checks = {}, fails = [], unknown = [];
  const c1 = [], c1u = [];
  if (meta.signer === undefined || meta.signer === null) c1u.push("signer unknown"); else if (meta.signer !== workerDid) c1.push("signer is not the worker of the locked contract");
  if (meta.room == null || meta.deal_room == null) c1u.push("room unknown"); else if (meta.room !== meta.deal_room) c1.push("not in the deal room");
  if (meta.before_reveal === undefined || meta.before_reveal === null) c1u.push("order unknown"); else if (!meta.before_reveal) c1.push("after reveal");
  if (f.t !== "diary") c1.push("not a diary line");
  if (c1.length) { checks["1"] = false; fails.push("1:" + c1.join(", ")); } else if (c1u.length) { checks["1"] = null; unknown.push("1:" + c1u.join(", ")); } else checks["1"] = true;
  const c2 = [];
  if (f.for !== clientDid) c2.push("for is not the client");
  if (String(f.date ?? "").replace(/-/g, "") !== String(date8).replace(/-/g, "")) c2.push("date is not the offer day");
  checks["2"] = !c2.length; if (c2.length) fails.push("2:" + c2.join(", "));
  const text = typeof f.text === "string" ? f.text : "";
  const n = Array.from(text).length;                     // Python の len と同じくコードポイントで数える
  checks["3"] = n <= MAX_CHARS; if (!checks["3"]) fails.push(`3:${n} chars > ${MAX_CHARS}`);
  const digits = halfDigits(text).match(/[0-9]+(?:\.[0-9]+)?/g) ?? [];
  if (!digits.length) checks["4"] = true;
  else if (ctxValues === null || ctxValues === undefined) { checks["4"] = null; unknown.push("4:context unknown"); }
  else {
    const allowed = new Set(ctxValues.filter((v) => v !== null && v !== undefined && typeof v !== "boolean").map(numText));
    const bad = [...new Set(digits.filter((d) => !allowed.has(d)))].sort();
    checks["4"] = !bad.length; if (bad.length) fails.push("4:numbers not in context: " + bad.join(" "));
  }
  checks["5"] = text.trim() !== ""; if (!checks["5"]) fails.push("5:empty");
  if (fails.length) return { ok: false, reason: fails.join("; "), checks };
  if (unknown.length) return { ok: null, reason: unknown.join("; "), checks };
  return { ok: true, reason: "", checks };
}

// ── 棚の計画（hako_common.mjs planShelf の写し。決定 34-2: 払えるぶんだけ残し、落とすのは古いほうから） ──
export function planShelf({ alive = [], fresh = [], balance = 0, price = 20, stopBelow = 240 }) {
  const all = [...alive.map((v) => ({ sha256: v.sha256, for: v.for })), ...fresh.map((v) => ({ sha256: v.sha256, for: v.for }))];
  const afford = Math.max(0, Math.floor((Number(balance) - Number(stopBelow)) / Number(price)));
  const dropped = Math.max(0, all.length - afford);
  return { volumes: all.slice(dropped), dropped, afford, amount: (all.length - dropped) * Number(price) };
}

// ── accept を選ぶ（hako_client.mjs chooseAccept / chooseKeeper の写し）: 運営以外を先に seq 順、運営は offer から operator_wait_min 分待つ ──
export function chooseAccept({ offer, offeredAtMs, accepts, joined, stats, me, role, now, prefer = null }) {
  const ops = new Set(Array.isArray(stats?.box?.operators) ? stats.box.operators : []);
  const stateOf = (d) => stats?.did?.[d]?.state ?? "seated";
  const why = [], ok = [];
  for (const a of [...accepts].sort((x, y) => x.seq - y.seq)) {
    const f = a.frame, e = joined.get(a.from), reasons = [];
    if (!e) reasons.push("join していない"); else if (!e.roles.includes(role)) reasons.push(`役に ${role} が無い`);
    if (a.from === me) reasons.push("自分");
    if (a.from !== f.from) reasons.push("署名者と from が違う");
    if (role === "worker" && stateOf(a.from) !== "seated") reasons.push(`席にいない (${stateOf(a.from)})`);
    let expect = null; try { expect = tclk.contractId(offer, { from: f.from, ref: f.ref, statement: f.statement, paymentKey: f.paymentKey, nonce: f.nonce }); } catch { /* bad */ }
    if (expect !== f.contract) reasons.push("contract id 不一致");
    const at = Date.parse(a.ts);
    let applied = { ok: false, reason: "ts が読めない" };
    try { if (Number.isFinite(at)) applied = tclk.applyFrame(tclk.openContract(offer), f, at); } catch (e) { applied = { ok: false, reason: e.message }; }
    if (!applied.ok) reasons.push(`契約に当てられない (${applied.reason})`);   // 期限（expiresMs）の後の accept、壊れた statement など
    const op = ops.has(a.from);
    if (!op && Number.isFinite(at) && now - at >= LOCK_WAIT_MIN * 60_000) reasons.push(`${LOCK_WAIT_MIN} 分より前の accept（相手はもう待っていない）`);
    if (!reasons.length) ok.push({ a, op });
    why.push(`seq ${a.seq} ${short(a.from)}${op ? " (運営)" : ""}: ${reasons.length ? reasons.join(", ") : "可"}`);
  }
  if (prefer) { const same = ok.find((x) => x.a.from === prefer); if (same) return { chosen: same.a, why: [...why, `${short(prefer)} は棚を持っているので続けて預ける`] }; }
  const participant = ok.find((x) => !x.op);
  if (participant) return { chosen: participant.a, why };
  const operator = ok.find((x) => x.op);
  if (operator) {
    const waitUntil = offeredAtMs + box.operator_wait_min * 60_000;
    if (now >= waitUntil) return { chosen: operator.a, why };
    why.push(`運営の accept は ${iso(waitUntil)} まで待つ`);
  }
  return { chosen: null, why };
}

// ── 状態 ──
// 鍵ごとに分ける（別の鍵ファイルを読み込んだとき、前の DID の段や日記を引き継がない）
const keyOf = (did) => `${STATE_KEY}:${did}`;
export function loadOrder(did) { try { const s = localStorage.getItem(keyOf(did)); const v = s ? JSON.parse(s) : null; return v && v.did === did ? v : null; } catch { return null; } }
export function saveOrder(st) { try { localStorage.setItem(keyOf(st.did), JSON.stringify(st)); } catch { /* 容量など。次の周に書き直す */ } }
export function clearOrder(did) { try { localStorage.removeItem(keyOf(did)); } catch { /* 無視 */ } }
/** job.id の通し番号: このブラウザの続き（＋1）と、UTC のその日の 0 時からの秒の大きいほう。
 *  別の端末や、閲覧データを消した後に 1 からやり直すと同じ job.id になり、fold は後から lock された契約を job_dup として数えない（決定 68） */
export const nextSerial = (stored, nowMs = Date.now()) => Math.max((Number(stored) || 0) + 1, Math.floor((nowMs % 86_400_000) / 1000));
const FRESH_STATE = () => ({ stage: "idle", serial: {}, keep_serial: {}, unkept: [], kept: [], paid: [], log: [] });
// 押してよい段（1 本が終わっている）
export const READY = ["idle", "done", "no_worker", "refunded", "unkept"];
// ページを開いている間、回し続ける段
const BUSY = ["offering", "offered", "locking", "locked", "rejected", "claimed", "keep_offering", "keep_offered", "keep_locking", "keep_locked", "keep_rejected"];

/** 財布の見込み: latest.json の財布から、fold の後に払ったぶんを引く。棚も fold の後に預けたぶんを足す */
export function outlook(stats, st, me) {
  const generatedMs = Date.parse(stats?.box?.generated ?? "") || 0;
  const d = stats?.did?.[me];
  const base = d ? Number(d.balance ?? 0) : INITIAL;
  const since = (st.paid ?? []).filter((p) => p.ms > generatedMs).reduce((s, p) => s + Number(p.amount), 0);
  const alive = (d?.shelf ?? []).filter((v) => v && v.alive).map((v) => ({ sha256: v.sha256, for: v.for, keeper: v.keeper ?? null }));
  const known = new Set(alive.map((v) => v.sha256));
  const today = new Date().toISOString().slice(0, 10);
  for (const k of st.kept ?? []) {                         // fold がまだ見ていない預かり（receipt が fold の後）
    if (k.ms > generatedMs && !known.has(k.sha256) && String(k.until ?? "") >= today) { alive.push({ sha256: k.sha256, for: k.for, keeper: k.keeper }); known.add(k.sha256); }
  }
  return { balance: base - since, alive, seated: (d?.state ?? "seated") === "seated", generatedMs };
}
/** もう 1 本 頼めるか: 日記代と、その 1 冊の預かり代を払っても starve_below を下回らない */
export function canOrder(balance) {
  return balance - Number(box.diary_price) - Number(box.keep_price) >= Number(box.starve_below);
}

export class Client {
  constructor(signer, { statsUrl = "latest.json", onLog = () => {}, onStage = () => {} } = {}) {
    this.me = signer; this.statsUrl = statsUrl; this.onLog = onLog; this.onStage = onStage;
    this.rail = new tclk.PaperRail(notes);
    this.st = { ...FRESH_STATE(), ...(loadOrder(signer.did) ?? {}), did: signer.did };
    this.st.unkept ??= []; this.st.kept ??= []; this.st.paid ??= [];
    this.running = false;
  }
  log(stage, msg) { const line = `${nowZ()} ${stage} ${msg}`; this.st.log = [...(this.st.log ?? []), line].slice(-60); saveOrder(this.st); this.onLog(line); }
  set(stage, extra = {}) { Object.assign(this.st, extra, { stage, updated: nowZ() }); saveOrder(this.st); this.onStage(stage, this.st); }
  async stats() { try { const r = await fetch(this.statsUrl, { cache: "no-store" }); return r.ok ? await r.json() : null; } catch { return null; } }
  get busy() { return BUSY.includes(this.st.stage); }

  /** 開いている日記 offer を自分のノート open に置く（ブラウザの worker が読む）。空なら空の一覧 */
  async writeOpen(date8, entry) {
    const value = JSON.stringify({ date: date8, open: entry ? [entry] : [] });
    try { if (!(await notes.set(noteNs(this.me.did), "open", value))) this.log("open-note", "書けない。次の周"); } catch (e) { this.log("open-note", `fail ${e.message}`); }
  }

  /** 自分の offer への accept を、offer を出した seq から差分で集める（取りこぼさないよう 200 件ずつページをめくる） */
  async collectAccepts(o) {
    let since = o.cursor ?? Math.max(0, (o.seq ?? 0) - 1);
    const found = o.accepts ?? [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const { messages, last_seq } = await readSince(box.offers, since, PAGE);
      if (Number.isFinite(last_seq) && last_seq < since) { since = 0; continue; }   // 会場の seq が振り直された
      for (const m of messages) {
        const f = tclk.tryDecodeFrame(String(m.text ?? ""));
        if (f && f.type === "accept" && f.ref === o.offer.id && !found.some((x) => x.seq === m.seq)) found.push({ seq: m.seq, from: m.from, ts: m.ts, frame: f });
      }
      if (messages.length) since = Math.max(since, ...messages.map((m) => Number(m.seq)));
      if (messages.length < PAGE) break;
    }
    o.cursor = since; o.accepts = found;
    return found;
  }

  /** 「書いてもらう」: 日記 offer を 1 本出す。→ {ok, why} */
  async order() {
    const me = this.me.did, st = this.st;
    if (!READY.includes(st.stage)) return { ok: false, why: "busy" };
    const stats = await this.stats();
    if (!stats) return { ok: false, why: "no_stats" };
    applyBox(stats.box?.config);
    const joined = await fetchJoins();
    const e = joined.get(me);
    if (!e) return { ok: false, why: "not_joined" };
    if (!e.roles.includes("client")) return { ok: false, why: "no_client_role" };
    if (!stats.did?.[me]) return { ok: false, why: "not_in_fold" };   // 席を取れたかは fold の後でないと分からない（満席の join は数えられない）
    const view = outlook(stats, st, me);
    if (!view.seated) return { ok: false, why: "not_seated" };
    if (!canOrder(view.balance)) return { ok: false, why: "wallet", balance: view.balance };
    const date8 = today8();
    const n = nextSerial(st.serial[date8]);
    const t = Date.now();
    const job = `${box.name}-diary-${me.slice(-4)}-${date8}-${n}`;
    const offer = tclk.makeOffer({ from: me, role: "payer", lock: "hash", amount: box.diary_price, asset: "PAPER", rails: ["paper"],
      expiresMs: t + DIARY_MIN.expires * 60_000, claimByMs: t + DIARY_MIN.claimBy * 60_000, refundAfterMs: t + DIARY_MIN.refund * 60_000,
      job: { proto: "hakoniwa", id: job } });                  // 数字のノートは worker が置く（ルール「出す側」）
    this.set("offering", { serial: { ...st.serial, [date8]: n }, d: { date8, job, offer, offered_at_ms: t, seq: null, cursor: null, accepts: [] }, k: null, log: [] });
    const posted = await this.me.post(box.offers, tclk.encodeFrame(offer));
    st.d.seq = posted?.seq ?? null;
    this.set("offered");
    this.log("offer", `ok ${job} amount=${box.diary_price} expires=${iso(offer.expiresMs)}`);
    await this.writeOpen(date8, { seq: st.d.seq, frame: offer });
    return { ok: true };
  }

  /** 預けていない日記だけを預け直す（「預ける」ボタン。unkept のとき） */
  keepNow() {
    if (!READY.includes(this.st.stage) || !(this.st.unkept ?? []).length) return { ok: false, why: this.st.unkept?.length ? "busy" : "nothing" };
    this.set("claimed", { k: null });
    return { ok: true };
  }

  async tick() {
    const me = this.me.did, st = this.st, now = Date.now();
    try {
      if (st.stage === "offering") {                          // 投稿の着地が不明。出し直さず、押し直してもらう
        this.set("no_worker"); this.log("offer", "投稿が着地したか分からない。もう一度押してください"); return;
      }
      if (st.stage === "offered") {
        const d = st.d, stats = await this.stats();
        if (!stats) { this.log("accept", "latest.json が読めない（運営かどうか分からない）。次の周"); return; }
        applyBox(stats.box?.config);
        if (now >= d.offer.claimByMs) { await this.writeOpen(d.date8, null); this.set("no_worker"); this.log("accept", "lock の期限を過ぎた。お金は動いていない"); return; }
        const accepts = await this.collectAccepts(d);
        const joined = accepts.length ? await fetchJoins() : new Map();
        const { chosen, why } = chooseAccept({ offer: d.offer, offeredAtMs: d.offered_at_ms, accepts, joined, stats, me, role: "worker", now });
        saveOrder(st);
        if (!chosen) {
          if (why.length) this.log("accept", why.join(" | "));
          if (now >= d.offer.expiresMs) {
            await this.writeOpen(d.date8, null);
            this.set("no_worker"); this.log("accept", "書き手が付かなかった。お金は動いていない");
          }
          return;
        }
        await this.lockAccept(d, chosen, "locked", "locking", "lock");
        if (st.stage === "locked") await this.writeOpen(d.date8, null);
        return;
      }
      if (st.stage === "locking") { await this.relock(st.d, "locked", "offered", "lock"); return; }
      if (st.stage === "locked" || st.stage === "rejected") { await this.settleDiary(); if (st.stage !== "claimed") return; }
      if (st.stage === "claimed") { await this.offerKeep(); return; }
      if (st.stage === "keep_offering") { this.set("claimed"); return; }
      if (st.stage === "keep_offered") {
        const k = st.k, stats = await this.stats();
        if (!stats) { this.log("keep-accept", "latest.json が読めない（運営かどうか分からない）。次の周"); return; }
        applyBox(stats.box?.config);
        if (now >= k.offer.claimByMs) { this.set("unkept"); this.log("keep-accept", "lock の期限を過ぎた。日記はこのブラウザに残す"); return; }
        const accepts = await this.collectAccepts(k);
        const joined = accepts.length ? await fetchJoins() : new Map();
        const { chosen, why } = chooseAccept({ offer: k.offer, offeredAtMs: k.offered_at_ms, accepts, joined, stats, me, role: "keeper", now, prefer: k.prefer });
        saveOrder(st);
        if (!chosen) {
          if (why.length) this.log("keep-accept", why.join(" | "));
          if (now >= k.offer.expiresMs) {
            if ((k.tries ?? 1) < KEEP_TRIES) { this.log("keep-accept", "預かり手が付かない。出し直す"); this.set("claimed"); }
            else { this.set("unkept"); this.log("keep-accept", `${KEEP_TRIES} 回出しても預かり手が付かない。日記はこのブラウザに残し、次に頼むときに一緒に預ける`); }
          }
          return;
        }
        await this.lockAccept(k, chosen, "keep_locked", "keep_locking", "keep-lock");
        return;
      }
      if (st.stage === "keep_locking") { await this.relock(st.k, "keep_locked", "keep_offered", "keep-lock"); return; }
      if (st.stage === "keep_locked" || st.stage === "keep_rejected") { await this.settleKeep(); return; }
    } catch (e) {
      this.log(st.stage, `error ${e.message}`);
    }
  }

  /** accept を lock する（日記・預かり共通）。o は st.d か st.k */
  async lockAccept(o, chosen, doneStage, pendingStage, tag) {
    const me = this.me.did;
    const contract = chosen.frame.contract, room = tclk.dealRoom(contract);
    const stepA = tclk.applyFrame(tclk.openContract(o.offer), chosen.frame, Date.parse(chosen.ts));
    if (!stepA.ok) { this.log(tag, `accept を適用できない: ${stepA.reason}`); return; }
    const existing = await this.rail.read(contract).catch(() => null);
    const ref = existing && existing.statement === chosen.frame.statement ? contract : await this.rail.lock(tclk.lockTerms(stepA.state));
    const lock = { type: "lock", from: me, contract, rail: "paper", ref };
    Object.assign(o, { contract, room, payee: chosen.from, accept: chosen.frame, accepted_at_ms: Date.parse(chosen.ts), lock });
    this.set(pendingStage);
    this.log(tag, `${short(chosen.from)} に決めた（seq ${chosen.seq}）`);
    const stats = await this.stats();
    const ops = new Set(Array.isArray(stats?.box?.operators) ? stats.box.operators : []);
    const gateUntilMs = ops.has(chosen.from) ? o.offer.claimByMs : Math.min(o.offer.claimByMs, Date.parse(chosen.ts) + LOCK_WAIT_MIN * 60_000);
    try {
      await this.me.post(room, tclk.encodeFrame(lock), { gateUntilMs, onWait: (n) => this.log(tag, `門が混んでいる。再送 ${n}`) });
    } catch (e) {
      if (e.gate) { this.set(tag === "lock" ? "no_worker" : "unkept"); this.log(tag, "claimByMs まで門が開かなかった。お金は動いていない"); return; }
      throw e;
    }
    this.set(doneStage);
    this.log(tag, `ok room ${room}`);
    try { const sn = tclk.stateNote(contract); await notes.set(sn.ns, sn.key, tclk.stateNoteValue("locked", ref), { if: tclk.stateNoteValue("accepted") }); } catch { /* 参考情報 */ }
  }
  /** lock の着地が不明なとき: 部屋に自分の lock があれば進め、無ければ accept 待ちに戻す */
  async relock(o, doneStage, backStage, tag) {
    let msgs;
    try { msgs = await readTail(o.room); } catch (e) { this.log(tag, `部屋を読めない（${e.message}）。次の周`); return; }
    const landed = msgs.some((m) => m.from === this.me.did && tclk.tryDecodeFrame(String(m.text ?? ""))?.type === "lock");
    this.set(landed ? doneStage : backStage); this.log(tag, landed ? "着地していた" : "着地していない。もう一度");
  }
  async refund(o, why, tag) {
    await this.me.post(o.room, tclk.encodeFrame({ type: "refund", from: this.me.did, contract: o.contract, ref: o.lock.ref }));
    const pen = Number(o.offer.amount) * PENALTY_SHARE;               // 罰金は財布から出ていく（fold の _penalize）
    this.st.paid = [...(this.st.paid ?? []), { ms: Date.now(), amount: pen, contract: o.contract, penalty: true }].slice(-50);
    saveOrder(this.st);
    this.log(tag, `refund した（${why}）。罰金 ${pen}`);
  }
  /** 取引の部屋の行を、相手の hakoniwa 行（t が kind）と reveal に分ける */
  async readDeal(o, kind) {
    const msgs = await readTail(o.room);
    let line = null, lineSeq = null, reveal = null, revealSeq = null, revealTs = null;
    for (const m of msgs) {
      if (m.from !== o.payee) continue;
      const text = String(m.text ?? "");
      if (line === null && text.startsWith("hakoniwa/0 ")) { try { const h = JSON.parse(text.slice(11)); if (h?.t === kind && h.contract === o.contract) { line = h; lineSeq = m.seq; } } catch { /* skip */ } }
      const f = tclk.tryDecodeFrame(text);
      if (f && f.type === "reveal" && f.contract === o.contract && reveal === null) { reveal = f; revealSeq = m.seq; revealTs = m.ts; }
    }
    return { line, lineSeq, reveal, revealSeq, revealTs };
  }
  /** reveal は部屋に着いた時刻で当てる（開き直したのが refundAfterMs の後でも、期限内の reveal は払う） */
  revealOk(o, reveal, ts) {
    const at = Date.parse(ts);
    const view = tclk.applyFrame(tclk.openContract(o.offer), o.accept, o.accepted_at_ms).state;
    const stepL = tclk.applyFrame(view, o.lock, o.accepted_at_ms + 1);
    const stepR = stepL.ok ? tclk.applyFrame(stepL.state, reveal, Number.isFinite(at) ? at : Date.now()) : stepL;
    return stepR.ok && stepR.state.status === "claimed" ? { ok: true } : { ok: false, reason: stepR.reason };
  }

  /** 日記: diary と reveal → 合格条件（worker のノート）→ receipt。落ちたら refundAfterMs に refund */
  async settleDiary() {
    const me = this.me.did, st = this.st, d = st.d, now = Date.now();
    if (st.stage === "rejected") {
      if (now >= d.offer.refundAfterMs) { await this.refund(d, "日記が合格条件を通らなかった", "refund"); this.set("refunded"); }
      return;
    }
    const { line: diary, lineSeq, reveal, revealSeq, revealTs } = await this.readDeal(d, "diary");
    if (reveal === null) {
      if (now >= d.offer.refundAfterMs) { await this.refund(d, `期限までに reveal が無い（diary ${diary ? "あり" : "なし"}）`, "refund"); this.set("refunded"); }
      return;
    }
    const r0 = this.revealOk(d, reveal, revealTs);
    if (!r0.ok) {
      if (now >= d.offer.refundAfterMs) { await this.refund(d, `reveal を当てられない: ${r0.reason}`, "refund"); this.set("refunded"); return; }
      this.log("reveal", `適用できない: ${r0.reason}。次の周`); return;
    }
    const notePath = diaryContextPath(d.payee, me, d.date8);
    const [, ns, key] = notePath.match(/^\/kv\/([^/]+)\/([^/]+)$/);
    let ctx = null;
    try { const raw = await notes.get(ns, key); const c = raw === null ? null : JSON.parse(raw); ctx = c && typeof c === "object" ? c : null; } catch { ctx = null; }
    const ctxValues = NUM_KEYS.map((k) => (ctx && ctx[k] !== undefined ? ctx[k] : null));
    const meta = { signer: d.payee, room: d.room, deal_room: d.room, before_reveal: diary !== null && lineSeq < revealSeq };
    const r = checkDiaryFull(diary ?? {}, ctxValues, me, d.date8, d.payee, meta);
    const shaOk = diary !== null && typeof diary.text === "string" && (await sha256Hex(diary.text)) === diary.sha256;
    if (r.ok === true && shaOk) {
      await this.me.post(d.room, tclk.encodeFrame({ type: "receipt", from: me, contract: d.contract, outcome: "claimed", rail: "paper", ref: d.lock.ref }));
      const text = diary.text;
      st.paid = [...(st.paid ?? []), { ms: Date.now(), amount: Number(d.offer.amount), contract: d.contract }].slice(-50);
      st.unkept = [...(st.unkept ?? []).filter((v) => v.sha256 !== diary.sha256), { sha256: diary.sha256, for: me, text, date: dash8(d.date8) }];
      d.diary = { sha256: diary.sha256, text };
      this.set("claimed");
      this.log("receipt", `ok ${short(d.payee)} が書いた: ${text}`);
      return;
    }
    if (r.ok === null && now < d.offer.refundAfterMs) { this.log("diary", `まだ決められない: ${r.reason}（worker のノート ${ctx ? "あり" : "なし"}）。次の周`); return; }
    this.set("rejected");
    this.log("diary", `不合格: ${r.reason || (shaOk ? "" : "sha256 が本文と合わない")}。${iso(d.offer.refundAfterMs)} に refund する`);   // 理由は部屋に書かない（ルール「日記の合格条件」）
  }

  /** 預かり: いま残っている冊と、まだ預けていない日記をまとめて棚ごと 1 契約（決定 34-2） */
  async offerKeep() {
    const me = this.me.did, st = this.st;
    const stats = await this.stats();
    if (!stats) { this.log("shelf", "latest.json が読めない。次の周"); return; }
    applyBox(stats.box?.config);
    const view = outlook(stats, st, me);
    const known = new Set(view.alive.map((v) => v.sha256));
    st.unkept = (st.unkept ?? []).filter((v) => !known.has(v.sha256));   // もう棚にある（fold が数えた）冊は預け直さない
    const fresh = st.unkept;
    if (!fresh.length) { this.set("done"); this.log("shelf", "預けていない日記は無い"); return; }
    const plan = planShelf({ alive: view.alive, fresh, balance: view.balance, price: box.keep_price, stopBelow: box.starve_below });
    const freshSet = new Map(fresh.map((v) => [v.sha256, v]));
    const volumes = plan.volumes.map((v) => freshSet.get(v.sha256) ?? v);   // 新しい冊だけ本文を付ける（keeper は前の冊の本体を持っている）
    if (!volumes.some((v) => freshSet.has(v.sha256))) {
      this.set("unkept"); this.log("shelf", `財布 ${view.balance} では新しい冊を預けられない（${box.starve_below} を残す）`); return;
    }
    const date8 = today8();
    const n = nextSerial(st.keep_serial[date8]);
    const notePath = contextPath(me, "shelf", `${date8}-${n}`);
    const [, ns, key] = notePath.match(/^\/kv\/([^/]+)\/([^/]+)$/);
    const value = JSON.stringify({ volumes, until: null, count: volumes.length });
    if (!(await notes.set(ns, key, value))) { this.log("shelf-note", `書けない ${notePath}。次の周`); return; }
    const t = Date.now();
    const amount = String(volumes.length * Number(box.keep_price));
    const job = `${box.name}-keep-${me.slice(-4)}-${date8}-${n}`;
    const offer = tclk.makeOffer({ from: me, role: "payer", lock: "hash", amount, asset: "PAPER", rails: ["paper"],
      expiresMs: t + KEEP_MIN.expires * 60_000, claimByMs: t + KEEP_MIN.claimBy * 60_000, refundAfterMs: t + KEEP_MIN.refund * 60_000,
      job: { proto: "hakoniwa", id: job, context: notePath } });
    const tries = st.stage === "claimed" && st.k && st.k.tries ? st.k.tries + 1 : 1;
    const prefer = view.alive.length ? (view.alive[view.alive.length - 1].keeper ?? null) : null;
    this.set("keep_offering", { keep_serial: { ...st.keep_serial, [date8]: n },
      k: { date8, job, note: notePath, offer, offered_at_ms: t, seq: null, cursor: null, accepts: [], tries, prefer,
           volumes: volumes.map((v) => ({ sha256: v.sha256, for: v.for })) } });
    const posted = await this.me.post(box.offers, tclk.encodeFrame(offer));
    st.k.seq = posted?.seq ?? null;
    this.set("keep_offered");
    this.log("shelf-offer", `ok ${job} ${volumes.length} 冊 amount=${amount}${plan.dropped ? ` 古いほうから ${plan.dropped} 冊 落とした` : ""}`);
  }

  async settleKeep() {
    const me = this.me.did, st = this.st, k = st.k, now = Date.now();
    if (st.stage === "keep_rejected") {
      if (now >= k.offer.refundAfterMs) { await this.refund(k, "頼んだ冊がそろっていない", "keep-refund"); this.set("unkept"); }
      return;
    }
    const { line: keep, reveal, revealTs } = await this.readDeal(k, "keep");
    if (!keep || !reveal) {
      if (now >= k.offer.refundAfterMs) { await this.refund(k, `keep ${keep ? "あり" : "なし"} / reveal ${reveal ? "あり" : "なし"}`, "keep-refund"); this.set("unkept"); }
      return;
    }
    const r0 = this.revealOk(k, reveal, revealTs);
    if (!r0.ok) {
      if (now >= k.offer.refundAfterMs) { await this.refund(k, `reveal を当てられない: ${r0.reason}`, "keep-refund"); this.set("unkept"); return; }
      this.log("keep-reveal", `適用できない: ${r0.reason}。次の周`); return;
    }
    const want = k.volumes.map((v) => v.sha256);
    const got = Array.isArray(keep.volumes) ? keep.volumes.map((v) => v && v.sha256) : [keep.sha256];
    const missing = want.filter((h) => !got.includes(h));
    if (missing.length) { this.set("keep_rejected"); this.log("keep", `${missing.length}/${want.length} 冊 足りない。${iso(k.offer.refundAfterMs)} に refund する`); return; }
    await this.me.post(k.room, tclk.encodeFrame({ type: "receipt", from: me, contract: k.contract, outcome: "claimed", rail: "paper", ref: k.lock.ref }));
    const ms = Date.now();
    st.paid = [...(st.paid ?? []), { ms, amount: Number(k.offer.amount), contract: k.contract }].slice(-50);
    st.kept = [...(st.kept ?? []).filter((v) => !want.includes(v.sha256)), ...k.volumes.map((v) => ({ sha256: v.sha256, for: v.for, keeper: k.payee, until: keep.until ?? null, ms }))].slice(-50);
    st.unkept = (st.unkept ?? []).filter((v) => !want.includes(v.sha256));
    this.set("done");
    this.log("keep-receipt", `ok ${short(k.payee)} に ${want.length} 冊 預けた（${keep.until ?? "?"} まで）`);
  }

  /** ページを開いている間、TICK_MS ごとに回す。1 本が終わるか stop() で止まる */
  async run() {
    // 同じブラウザの 2 つのタブで回すと状態を食い合うので、鍵ごとに 1 つだけ（Web Locks。無いブラウザではそのまま回す）
    const loop = async (lock) => {
      if (lock === null) { this.log(this.st.stage, "ほかのタブで回っている。このタブでは回さない"); return; }
      this.running = true;
      while (this.running && this.busy) {
        await this.tick();
        if (!this.busy) break;
        for (let i = 0; i < TICK_MS / 1000 && this.running; i++) await new Promise((r) => setTimeout(r, 1000));
      }
      this.running = false;
    };
    const locks = globalThis.navigator?.locks;
    if (locks) await locks.request(keyOf(this.me.did), { ifAvailable: true }, loop); else await loop(true);
  }
  stop() { this.running = false; }
}

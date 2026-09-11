// hako_board.mjs — /r/hakoniwa-board の export から「庭に join 済みの DID と役」を取る（hakoniwa_fold.py と同じ読み方）。
// hako_miner.mjs と hako_test_payer.mjs が使う（決定 12: accept を出す側は join 済み DID の accept が先にあれば見送り、
// 払う側は join 済みでその役を持つ DID の accept を lock する）。
//
// 読み方（hakoniwa_fold.py の verify / join と同じ）:
//   - 行は 1 行 1 JSON（seq, ts, from, text, nonce, sig）。from が did:key: で、sig と nonce があるものだけ
//   - 署名は Ed25519、対象は `room|nonce|text`（text は空白を 1 つに畳む）、sig は base64url（padding なし）
//   - did:key は 0xed01 ＋ 公開鍵 32 バイトを base58btc にして z を付けたもの
//   - hakoniwa/0 {"t":"join", "roles": [...]} の行。roles は最後の join。無いか空なら worker と client
//   - 同じ (generation, seq) は 1 回だけ。generation は X-Room-Generation（ここでは 1 回の export なので seq の重複だけ落とす）
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { BOARD_ROOM } from "./hako_box.mjs";

export { BOARD_ROOM };                      // 掲示板の部屋名は hako_box.json（既定 hakoniwa-board）
export const DEFAULT_ROLES = ["worker", "client"];
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");   // DER の SPKI 前置き（Ed25519、鍵 32 バイト）

export function base58Decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`base58: bad char ${ch}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.push(Number(n & 0xffn)); n >>= 8n; }
  bytes.reverse();
  let zeros = 0;
  for (const ch of s) { if (ch === "1") zeros += 1; else break; }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes)]);
}

export function publicKeyFromDid(did) {
  if (!did.startsWith("did:key:z")) throw new Error("not a did:key");
  const raw = base58Decode(did.slice("did:key:z".length));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) throw new Error("not an ed25519 did:key");
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw.subarray(2)]), format: "der", type: "spki" });
}

/** technocore の署名レーン: sign("room|nonce|text")、text は空白を 1 つに畳んだもの。通らなければ false */
export function verifyRow(room, m) {
  try {
    if (typeof m.from !== "string" || !m.from.startsWith("did:key:") || m.sig === undefined || m.nonce === undefined) return false;
    const text = String(m.text).split(/\s+/).filter(Boolean).join(" ");
    const payload = Buffer.from(`${room}|${m.nonce}|${text}`, "utf8");
    const sig = Buffer.from(String(m.sig), "base64url");
    return cryptoVerify(null, payload, publicKeyFromDid(m.from), sig);
  } catch { return false; }
}

export function parseExportLines(raw) {
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m && typeof m.seq === "number") rows.push(m); } catch { /* skip */ }
  }
  return rows;
}

/** rows（export の行）→ { joined: Map<did, {roles, lang, joined_ts, seq}>, stats } */
export function parseJoins(rows, room = BOARD_ROOM) {
  const joined = new Map();
  const stats = { rows: 0, dup: 0, unsigned: 0, bad_sig: 0, joins: 0 };
  const seen = new Set();
  for (const m of [...rows].sort((a, b) => a.seq - b.seq)) {
    stats.rows += 1;
    if (seen.has(m.seq)) { stats.dup += 1; continue; }
    seen.add(m.seq);
    if (typeof m.from !== "string" || !m.from.startsWith("did:key:") || m.sig === undefined || m.nonce === undefined) { stats.unsigned += 1; continue; }
    if (!verifyRow(room, m)) { stats.bad_sig += 1; continue; }
    const t = String(m.text).trim();
    if (!t.startsWith("hakoniwa/0 ")) continue;
    let f;
    try { f = JSON.parse(t.slice("hakoniwa/0 ".length)); } catch { continue; }
    if (!f || typeof f !== "object" || f.t !== "join") continue;
    stats.joins += 1;
    const prev = joined.get(m.from);
    const roles = Array.isArray(f.roles) && f.roles.length > 0 ? f.roles.map(String) : [...DEFAULT_ROLES];   // 役は最後の join
    joined.set(m.from, { roles, lang: typeof f.lang === "string" ? f.lang : "en",
      joined_ts: prev ? prev.joined_ts : m.ts, seq: prev ? prev.seq : m.seq });                              // 入った時刻は最初の join
  }
  return { joined, stats };
}

/** 会場から掲示板の export を取って parseJoins する。req は hako_common の req(url, init, what)（本文の読み取りも再試行する） */
export async function fetchJoins(base, req) {
  const { reqText } = await import("./hako_common.mjs");
  const { res, text } = await reqText(`${base}/r/${BOARD_ROOM}/export`, undefined, `export ${BOARD_ROOM}`);
  if (!res.ok) throw new Error(`export ${BOARD_ROOM}: ${res.status}`);
  const gen = res.headers.get("x-room-generation");
  return { generation: gen === null ? null : Number(gen), ...parseJoins(parseExportLines(text)) };
}

export const hasRole = (entry, role) => !!entry && entry.roles.includes(role);

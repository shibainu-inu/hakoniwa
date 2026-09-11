// hako_box.mjs — 箱の設定（決定 16 ②）。hako_box.json（HAKO_BOX で場所を変えられる）を読む。無ければ既定＝いまの値。
// hakoniwa_fold.py の load_box() と同じ規則: "board" が無ければ "<box>-board"。掲示板・job.id の接頭辞・ノートの名前空間は箱の名前から作る。
// 依存なし（hako_common.mjs と hako_board.mjs の両方から読むため）。ブラウザ（web/hako_worker_web.js）は latest.json の box.config を読む
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BOX_DEFAULTS = {
  box: "hakoniwa", venue: "https://technocore.chat", offers_room: "tclk-offers", initial_paper: 1000,
  diary_price: 400, inference_price: 240, inference_min: 240, graduate_at: 1500, seats: 72, starve_below: 240, leave_after_midnights: 2,
  client_max_per_day: 20, operator_wait_min: 30, client_interval_sec: 300, worker_interval_sec: 600, miner_interval_sec: 300,
  validator_share: 0.15,
  operators: ["did:key:z6MkmG1MiumCr8Jk6vL5qt2A1XzEst6CVT5rwRHUHYwKPvqA", "did:key:z6Mkig6Ex8yT25TbmV7TFEJBGPAE8aq6DpXbZHMyrJkq88xr",
              "did:key:z6Mkq52a8jJna9yBCGyTL6hbMuqQiMbxihFcuQeSUuyGhE3T"],
};

export function loadBox(p = process.env.HAKO_BOX ?? path.join(HERE, "hako_box.json")) {
  const cfg = { ...BOX_DEFAULTS };
  let sha = null;
  if (existsSync(p)) {
    const raw = readFileSync(p);
    sha = createHash("sha256").update(raw).digest("hex");
    Object.assign(cfg, JSON.parse(raw.toString("utf8")));
  }
  cfg.board ??= `${cfg.box}-board`;
  cfg._path = p; cfg._sha256 = sha;
  return cfg;
}

export const BOX = loadBox();
/** 掲示板の部屋名 */
export const BOARD_ROOM = BOX.board;
/** offer と accept の部屋（tclk の共有の部屋。箱が違っても job.id の接頭辞で見分ける） */
export const OFFER_ROOM = BOX.offers_room;
/** job.id の接頭辞: <box>-<kind>-（kind は diary / inf / keep） */
export const jobPrefix = (kind) => `${BOX.box}-${kind}-`;
/** ノートの名前空間: <box>-<DID 末尾 8 文字を小文字> */
export const noteNs = (did) => `${BOX.box}-${String(did).slice(-8).toLowerCase()}`;
/** 仕事の context ノートのパス（hako_rules.context_path と同じ）: /kv/<box>-<末尾 8>/<kind>-<suffix> */
export const contextPath = (did, kind, suffix) => `/kv/${noteNs(did)}/${kind}-${suffix}`;

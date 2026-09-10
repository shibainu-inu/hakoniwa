#!/usr/bin/env python3
"""hako_export.py v0.5 — 部屋の /export を取り、新しい行だけを手元に残す。

    python3 hako_export.py tclk-offers                # 1 部屋
    python3 hako_export.py hakoniwa-board --deals     # 掲示板と、見つかっている派生ルーム全部と、日記 offer の context ノート
    python3 hako_export.py --list                     # 追っている部屋と cursor を表示

取り方（technocore-chat 20a4457 で確認）:
  - `GET /r/<room>/export` はクエリを受けない。リングに残っている全行を、書かれたままの
    バイト列（1 行 1 JSON: seq, ts, from, text, nonce, sig）で返す。
    ヘッダ `X-Room-Generation` が部屋の世代（作り直されるたびに増える。0 = 一度も無い）
  - 通常読み `GET /r/<room>?since=` は「seq > since のうち新しい方から最大 200 件」なので、
    溜まると古い側が落ちる。差分は手元で作る

残し方:
  ~/hako_export/<room>/g<世代>_<YYYYMMDDTHHMMSSZ>.jsonl   今回新しく見えた行だけ（バイト列そのまま）。
                                                 世代はヘッダの X-Room-Generation（無ければ cursor の値、それも無ければ 0）
  ~/hako_export/<room>/cursor.json               {"generation": g, "last_seq": n, "updated": ts}
  ~/hako_export/deals.json                       契約 id → 派生ルーム（tclk-offers の accept から）
  ~/hako_export/kv/<ns>/<key>/<YYYYMMDDTHHMMSSZ>.json   context ノートの写し（本文そのまま。前の写しと同じなら書かない）
  ~/hako_export/log                              1 回 1 行

世代が変わったら cursor を捨てて、その部屋を新しい世代として扱う（古い行はファイルに残る。
hakoniwa_fold.py はファイル名の g<N>_ で世代を見分け、同じ (部屋, 世代, seq) を 1 回だけ数える）。
派生ルームは、tclk-offers に保存した offer/accept のうち job.id が hakoniwa- で始まるものから、
tclk_ids.contract_id で contract を計算し直して accept の contract と一致したものだけ登録する。
--deals では、hakoniwa-diary- の offer（DEAL_DAYS 以内）の job.context（/kv/<ns>/<key>）に書かれたパスをそのまま取りに行き、
本文を kv/ の下に残す。パスの正しい形は hako_rules.context_path（末尾 8 文字は小文字。Technocore の名前空間は小文字限定）で、
違う形（大文字など）なら取れないので log に残す。hakoniwa_fold.py はその写し（いちばん古いもの）で日記の合格条件 4 を判定する。
Technocore の note 読みは先頭に「!! UNTRUSTED CONTENT」の 1 行と空行、末尾に「# budget:」の 1 行が付くことがあるので、
それを外した本文だけを残す。
"""
import sys, os, re, json, socket, datetime as dt, urllib.request, urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tclk_ids  # noqa: E402
import hako_rules  # noqa: E402

BASE = os.environ.get("TECHNOCORE_URL", "https://technocore.chat")
ROOT = Path(os.environ.get("HAKO_EXPORT_DIR", Path.home() / "hako_export"))
DEAL_DAYS = 8  # 派生ルームを追い続ける日数（リングは 7 日）
JOB_PREFIX = "hakoniwa-"
DIARY_PREFIX = "hakoniwa-diary-"
KV_DIR = "kv"
_KV_PATH = re.compile(r"^/kv/([^/]+)/([^/]+)$")
_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")   # technocore の <ns> / <key>（小文字限定）
_BANNER = "!! UNTRUSTED CONTENT"

# 自宅回線は IPv6 が通らず 8 秒待たされる（9/9 実測）。既定で IPv4 に固定する
if os.environ.get("HAKO_IPV6") != "1":
    _gai = socket.getaddrinfo
    socket.getaddrinfo = lambda host, port, family=0, *a, **k: _gai(host, port, socket.AF_INET, *a, **k)


def now_z():
    return dt.datetime.now(dt.timezone.utc)


def stamp(t=None):
    return (t or now_z()).strftime("%Y%m%dT%H%M%SZ")


def log(msg):
    ROOT.mkdir(parents=True, exist_ok=True)
    line = f"{stamp()} {msg}"
    print(line)
    with open(ROOT / "log", "a", encoding="utf-8") as f:
        f.write(line + "\n")


def fetch_export(room):
    """戻り値: (generation:int|None, raw:bytes)。生の bytes を返す（1 行 1 レコード）。"""
    req = urllib.request.Request(f"{BASE}/r/{room}/export", headers={"User-Agent": "hako_export/0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        gen = r.headers.get("X-Room-Generation")
        return (int(gen) if gen is not None else None), r.read()


def read_cursor(room):
    p = ROOT / room / "cursor.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {"generation": None, "last_seq": 0, "updated": None}


def write_cursor(room, cur):
    (ROOT / room).mkdir(parents=True, exist_ok=True)
    (ROOT / room / "cursor.json").write_text(json.dumps(cur), encoding="utf-8")


def save_room(room):
    """1 部屋ぶん取って、新しい行だけを保存。戻り値は保存した行数。"""
    try:
        gen, raw = fetch_export(room)
    except urllib.error.HTTPError as e:
        log(f"{room} HTTP {e.code}")
        return 0
    except Exception as e:  # noqa: BLE001
        log(f"{room} error {type(e).__name__}: {e}")
        return 0
    cur = read_cursor(room)
    if cur["generation"] is not None and gen is not None and gen != cur["generation"]:
        log(f"{room} generation {cur['generation']} -> {gen}: cursor reset")
        cur = {"generation": gen, "last_seq": 0, "updated": None}
    new_lines, last_seq, seen = [], cur["last_seq"], 0
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        seen += 1
        try:
            seq = json.loads(line)["seq"]
        except (ValueError, KeyError, TypeError):
            continue
        if seq > cur["last_seq"]:
            new_lines.append(line)
            last_seq = max(last_seq, seq)
    gen_out = gen if gen is not None else (cur["generation"] or 0)
    if new_lines:
        d = ROOT / room
        d.mkdir(parents=True, exist_ok=True)
        # 同じ秒に 2 回走っても上書きしない（追記）。世代はファイル名に残す
        with open(d / f"g{gen_out}_{stamp()}.jsonl", "ab") as f:
            f.write(b"\n".join(new_lines) + b"\n")
    cur.update(generation=gen if gen is not None else cur["generation"], last_seq=last_seq, updated=stamp())
    write_cursor(room, cur)
    log(f"{room} gen {gen} rows {seen} new {len(new_lines)} last_seq {last_seq}")
    return len(new_lines)


# ── 派生ルームの発見 ───────────────────────────────────────────────

def load_deals():
    p = ROOT / "deals.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def save_deals(deals):
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / "deals.json").write_text(json.dumps(deals, indent=1), encoding="utf-8")


def iter_saved(room):
    d = ROOT / room
    if not d.exists():
        return
    for p in sorted(d.glob("*.jsonl")):
        for line in p.read_bytes().split(b"\n"):
            if line.strip():
                try:
                    yield json.loads(line)
                except ValueError:
                    continue


def discover_deals():
    """保存済みの tclk-offers から、箱庭の accept を見つけて派生ルームを登録する。"""
    deals = load_deals()
    offers = {}
    added = 0
    for m in iter_saved("tclk-offers"):
        f = tclk_ids.decode_frame(str(m.get("text", "")))
        if not f:
            continue
        if f.get("type") == "offer" and str(f.get("job", {}).get("id", "")).startswith(JOB_PREFIX):
            offers[f.get("id")] = (f, m.get("seq"))
        elif f.get("type") == "accept" and f.get("ref") in offers and f.get("contract") not in deals:
            offer, offer_seq = offers[f["ref"]]
            try:
                cid = tclk_ids.contract_id(offer, f)
            except (KeyError, TypeError, ValueError):
                continue
            if cid != f.get("contract"):
                log(f"accept seq {m.get('seq')} contract mismatch: claimed {str(f.get('contract'))[:18]} computed {cid[:18]} (skip)")
                continue
            deals[cid] = {"room": tclk_ids.deal_room(cid), "job": offer["job"]["id"], "payer": offer["from"] if offer.get("role") == "payer" else f["from"],
                          "offer_seq": offer_seq, "accept_seq": m.get("seq"), "accept_ts": m.get("ts"), "found": stamp()}
            added += 1
    if added:
        save_deals(deals)
        log(f"deals: +{added} (total {len(deals)})")
    return deals


# ── context ノートの写し ───────────────────────────────────────────

def note_value(body):
    """note 読みの応答から本文だけを取り出す（先頭の UNTRUSTED バナーと空行、末尾の # budget 行を外す）"""
    if body.startswith(_BANNER):
        _, _, body = body.partition("\n\n")
    lines = body.split("\n")
    if len(lines) > 1 and lines[-1].startswith("# budget:"):
        lines = lines[:-1]
    return "\n".join(lines)


def fetch_note(path):
    """→ 本文（str）。無い・読めないときは None（log に残す）"""
    req = urllib.request.Request(f"{BASE}{path}", headers={"User-Agent": "hako_export/0.5"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return note_value(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        log(f"note {path} HTTP {e.code}")
    except Exception as e:  # noqa: BLE001
        log(f"note {path} error {type(e).__name__}: {e}")
    return None


def save_note(path):
    """ノートを取って kv/<ns>/<key>/<時刻>.json に本文をそのまま残す。前の写しと同じなら書かない。戻り値は書いたか"""
    mp = _KV_PATH.match(path or "")
    if not mp:
        log(f"note {path!r}: not a /kv/<ns>/<key> path (skip)")
        return False
    if not _NAME.match(mp.group(1)) or not _NAME.match(mp.group(2)):
        log(f"note {path}: ns/key must match {_NAME.pattern} (technocore names are lowercase; skip)")
        return False
    value = fetch_note(path)
    if value is None:
        return False
    d = ROOT / KV_DIR / mp.group(1) / mp.group(2)
    prev = sorted(d.glob("*.json"))
    if prev and prev[-1].read_text(encoding="utf-8") == value:
        return False
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{stamp()}.json").write_text(value, encoding="utf-8")
    log(f"note {path} saved {len(value)} chars")
    return True


def diary_contexts():
    """保存済みの tclk-offers から、DEAL_DAYS 以内の hakoniwa-diary- offer の job.context（あれば）と、
    その offer への accept ごとの worker のノート hako_rules.context_path(accept.from, "diary", offer の日) を集める（重複なし、seq 順）。
    v0.7 では数字のノートは worker が置く（fold の合格条件 4 はこちらを読む）"""
    cutoff = now_z() - dt.timedelta(days=DEAL_DAYS)
    seen, out, offers = set(), [], {}
    def add(p):
        if isinstance(p, str) and p not in seen:
            seen.add(p); out.append(p)
    for m in iter_saved("tclk-offers"):
        f = tclk_ids.decode_frame(str(m.get("text", "")))
        if not f:
            continue
        try:
            ts = dt.datetime.fromisoformat(str(m.get("ts")).replace("Z", "+00:00"))
        except ValueError:
            continue
        if f.get("type") == "offer":
            job = f.get("job") if isinstance(f.get("job"), dict) else {}
            if not str(job.get("id", "")).startswith(DIARY_PREFIX) or ts < cutoff:
                continue
            offers[f.get("id")] = ts.strftime("%Y%m%d")
            add(job.get("context"))
        elif f.get("type") == "accept" and f.get("ref") in offers and isinstance(f.get("from"), str):
            add(hako_rules.context_path(f["from"], "diary", offers[f["ref"]]))
    return out


def active_deal_rooms(deals):
    cutoff = now_z() - dt.timedelta(days=DEAL_DAYS)
    rooms = []
    for cid, d in deals.items():
        try:
            found = dt.datetime.strptime(d["found"], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
        except (KeyError, ValueError):
            found = now_z()
        if found >= cutoff:
            rooms.append(d["room"])
    return rooms


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if "--list" in argv:
        for d in sorted(p for p in ROOT.iterdir() if p.is_dir()) if ROOT.exists() else []:
            print(d.name, read_cursor(d.name))
        print("deals:", len(load_deals()))
        return 0
    if not args and "--deals" not in argv:
        print(__doc__)
        return 2
    total = 0
    for room in args:
        total += save_room(room)
    if "--deals" in argv:
        deals = discover_deals()
        for room in active_deal_rooms(deals):
            total += save_room(room)
        for path in diary_contexts():
            save_note(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

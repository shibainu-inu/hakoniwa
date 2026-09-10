#!/usr/bin/env python3
"""hakoniwa_fold.py v0.7 — 箱庭の集計。保存した export だけから、DID ごとの 5 つの数字と席の状態を出す。

使い方:
  python3 hakoniwa_fold.py --dir ~/hako_export [--json] [--out ~/hako_stats]
      各サブディレクトリを部屋として読む（部屋名＝ディレクトリ名、行はその中の *.jsonl 全部）。
      同じ (部屋, generation, seq) は 1 回だけ数える。generation はファイル名の先頭 g<N>_ か、
      無ければその部屋の cursor.json の値（無ければ 0）。
      <dir>/kv/<ns>/<key>/<時刻>.json は context ノートの写し（hako_export が残す）。部屋としては読まない
  python3 hakoniwa_fold.py board.jsonl [offers.jsonl deal.jsonl ...] [--room=<path>=<部屋名>] [--json]
      従来のファイル指定。部屋名は --room= か、ファイル名（拡張子を除く）。ノートの写しは無い扱い
  --out <dir>  出力 JSON を <dir>/<YYYYMMDDTHHMMSSZ>.json と <dir>/latest.json に書く

入力は technocore の /export（1 行 1 JSON: seq, ts, from, text, nonce, sig）。
やること（正は HAKONIWA-RULES.md v0.7 と DECISIONS-for-rules-v0.5.md 決定 1〜14。書いていない計算はしない）:
  1. 全行の署名を検証する（room|nonce|text を Ed25519 で）。通らない行・did:key でない行は捨てて件数だけ残す
  2. 掲示板 /r/hakoniwa-board: rules / join / mem / serve / issue
       join … 1,000 PAPER（joined）は最初の join だけ。役は最後の join。roles が無いか空なら worker と client。lang 省略時は en。
               席（SEATS）に入れなかった join と、枯渇・卒業のあとの join は数えない（下の 6）
       mem  … 行ごとに (ts, bytes) を残す。家賃は 5 で引く
       serve … text の UTF-8 の sha256 が sha256 と一致するかを記録
       issue … 運営の client への蛇口（v0.7）。出せるのは、その時点で有効な rules を最後に出した DID。to は運営の DID（OPERATOR_DIDS）で箱に入っているもの。
               pool が「to が date（UTC、lock の時刻）に lock した日記（試験を除く）の額の合計」と小数 2 桁で一致するときだけ to に配る（issued）。
               一致しなければ box.invalid_issue に残して配らない。同じ (date, to) は最初の 1 件。pool が 0 なら配らない
  3. /r/tclk-offers: offer / accept（asset PAPER、job.id が hakoniwa- で始まるものだけ）
       accept の contract は tclk_ids.contract_id で計算し直し、一致しないものは捨てて件数を残す。
       同じ offer に accept が複数あってよい（accept ごとに契約 id ができる）。有効なのは払う側が lock した契約だけ（決定 12）。
       payer が同じ offer に lock を 2 件以上出したら最初の 1 件（ts、同時なら seq）だけ数え、残りは lock_dup_offer。
       同じ job.id は最初に lock された 1 本だけ（残りは job_dup）。日記は 1 worker 1 日 1 本（worker_day_dup）、1 client 1 日 20 本まで
       （client_day_limit）。日は UTC、lock の時刻。lock されなかった契約と落とした契約は box.contracts_unlocked に残す
       job.id に -test- を含む契約は試験用。状態は box.test_contracts に別に残し（claimed なら would_settle に動いたはずの額）、
       PAPER も発行も本番の数字に入れない
  4. 派生ルーム（tclk_ids.deal_room）: lock / reveal / receipt / refund と、納品行 diary / inf / keep
       lock は払う側、reveal は受け取り側のものだけ（各 1 件）。receipt(claimed) は払う側が出し、同じ部屋にその lock と reveal が
       先にあるときだけ動く（契約ごとに最初の 1 件）。欠けていれば無視して件数を残す
       推論（hakoniwa-inf-）は 85% が受け取り側、15% は validator（receipt の時刻に有効な rules を最後に出した DID。無ければ庭の外）。
       日記代・預かり代は手数料なし
       refund は払う側が、lock の後、offer の refundAfterMs 以降に出し、claimed の receipt が無いときだけ動く。
       未消化分＝lock した額の全部。その 20% を払う側の食費と庭の外（burn）に足し、80% は動かさない。
       refundAfterMs 前の refund は無視して件数を残す
       diary 行は hako_rules.check_diary の結果を参考値として付ける。条件 4 の context は <dir>/kv/ の写し
       （worker のノート hako_rules.context_path(payee, "diary", offer の日)。いちばん古い写し）を読む。写しが無ければ ok=null のまま。
       条件 2 の for は worker の DID（v0.7: worker が自分の日記を書く）
  5. DID ごとに 稼ぎ(earn)・食費(spend)・貯え(balance)・記憶(mem_bytes)・余命(life_days) を出す
       貯え = 1,000 ＋ 稼ぎ ＋ 発行(issued) − 食費（取引・罰金・家賃）
       記憶の家賃は 00:00Z 刻み。各 00:00Z に、その時点で有効な mem（最後の mem 行）の bytes ぶん（1 KiB につき 1 PAPER）を引く。
       最初の請求は mem 行の後の最初の 00:00Z。mem を出し直したら次の 00:00Z から新しい bytes。
       貯え < その日の家賃なら引かず眠る（sleep_days +1）。眠りが 7 日続いたら mem_bytes を 0 にして記憶は消える
       余命 = 貯え ÷ 直近 7 日の 1 日あたり食費。食費ゼロなら null
       box.contracts: lock された契約ごとに 1 要素（契約の線の元データ。hako_avatar.links_from_box が読む）。
       contract / kind / payer / payee / room / locked_seq / locked_ts / settled_seq / settled_ts / outcome / dispute / test。
       時刻は unix 秒、outcome は receipt / refunded / null、test の契約も同じ配列に入れる（数字には入れない）
  6. 席の層（お金の流れは変えない）。join は seq 順に席（SEATS=72、運営の DID を含む）まで。満席の join は数えない（1,000 も役も無い）。
       退場は 3 つ: 枯渇 starved（貯えが STARVE_BELOW=240 を下回った時点。戻れない）、席を離れた left（00:00Z を 2 回、掲示板の行も
       lock された契約への関わりも無いまま越えた。空席があれば join で戻れる）、卒業 graduated（累計の稼ぎが GRADUATE_EARN=1,500 に達した
       receipt の時点。貯えは paper_total から外れて box.graduated_paper に載る。戻らない）。運営の DID は退場も卒業もしない。
       席の無い DID との契約も数字には入る（避けるのは script の側）。数えない join の集合が変わらなくなるまで畳み直す
出力 --json: {"box": {...}, "did": {did: {...}}}。did の値のキー名は README「fold の出力」の一覧で固定。
"""
import sys, os, re, json, base64, hashlib, datetime as dt
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import base58
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature
import tclk_ids
import hako_rules

INITIAL = 1000
MINER_SHARE = 0.85            # 推論代の 85% が miner、15% は validator（有効な rules を最後に出した DID）。validator が無ければ庭の外へ
PENALTY_SHARE = 0.20          # 途中でやめた罰金: 未消化分（lock した額の全部）の 20% が庭の外へ
RENT_PER_KIB_DAY = 1.0        # 記憶の家賃（仮）
SLEEP_DAYS_TO_ERASE = 7       # 眠りがこの日数続いたら記憶は消える
BOARD_ROOM = "hakoniwa-board"
OFFER_ROOM = "tclk-offers"    # tclk OFFER_ROOM（~/tclk/src/technocore.ts）
KV_DIR = "kv"                 # <dir>/kv/<ns>/<key>/<時刻>.json: context ノートの写し
JOB_PREFIX = "hakoniwa-"
INF_PREFIX = "hakoniwa-inf-"
TEST_MARK = "-test-"          # job.id にこれを含む契約は試験用（box.test_contracts に別集計）
DEFAULT_ROLES = ["worker", "client"]
# 運営の DID（HAKONIWA-RULES.md「役」）。席に数え、退場と卒業の対象外。issue の to に書けるのはこの DID だけ
OPERATOR_DIDS = ("did:key:z6MkmG1MiumCr8Jk6vL5qt2A1XzEst6CVT5rwRHUHYwKPvqA",   # …PvqA client・validator・juror・keeper
                 "did:key:z6Mkig6Ex8yT25TbmV7TFEJBGPAE8aq6DpXbZHMyrJkq88xr",   # …88xr worker・client・miner
                 "did:key:z6Mkq52a8jJna9yBCGyTL6hbMuqQiMbxihFcuQeSUuyGhE3T")   # …hE3T miner・worker・client
SEATS = 72                    # 席（運営の DID を含む）
STARVE_BELOW = 240.0          # 枯渇: 貯えが一番安い推論代を下回る
GRADUATE_EARN = 1500.0        # 卒業: 累計の稼ぎがこれに達した receipt
LEAVE_AFTER_MIDNIGHTS = 2     # 席を離れる: 00:00Z を 2 回、何もしないまま越えた
DIARY_PER_CLIENT_DAY = 20     # 1 つの client が 1 日（UTC、lock の時刻）に lock できる日記
SEAT_ITERATIONS = 8           # 数えない join が変わらなくなるまで畳み直す回数の上限
DEFAULT_LANG = "en"
CONTEXT_KEYS = ("earn", "spend", "balance", "mem_bytes", "life_days")
BOARD_KINDS = ("rules", "join", "mem", "serve", "issue")
DEAL_TCLK = ("lock", "reveal", "receipt", "refund")
DEAL_HAKO = ("diary", "inf", "keep")
_GEN_FILE = re.compile(r"^g(\d+)_")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_KV_PATH = re.compile(r"^/kv/([^/]+)/([^/]+)$")


# ── 署名 ──────────────────────────────────────────────────────────────

def pub_from_did(did):
    raw = base58.b58decode(did.removeprefix("did:key:z"))
    assert raw[:2] == b"\xed\x01", "not ed25519 did:key"
    return Ed25519PublicKey.from_public_bytes(raw[2:])

def verify(room, m):
    """technocore の署名レーン: sign("room|nonce|text")、text は空白を 1 つに畳んだもの"""
    text = " ".join(str(m["text"]).split())
    payload = f"{room}|{m['nonce']}|{text}".encode()
    try:
        sig = base64.urlsafe_b64decode(m["sig"] + "=" * (-len(m["sig"]) % 4))
        pub_from_did(m["from"]).verify(sig, payload); return True
    except (InvalidSignature, Exception):
        return False


# ── 入力 ──────────────────────────────────────────────────────────────

def parse_ts(ts):
    return dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))

def read_lines(path):
    rows = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line: continue
        try: m = json.loads(line)
        except json.JSONDecodeError: continue
        if not isinstance(m, dict) or not all(k in m for k in ("seq", "ts", "from", "text")): continue
        rows.append(m)   # nonce / sig の無い行（署名なしの /say）は unsigned として数える
    return rows

def load_dir(root):
    """→ [(room, generation, row)]。部屋＝サブディレクトリ名（kv/ は除く）"""
    root = Path(root).expanduser()
    out = []
    for d in sorted(p for p in root.iterdir() if p.is_dir() and p.name != KV_DIR):
        gen_default = 0
        cur = d / "cursor.json"
        if cur.exists():
            try: gen_default = int(json.load(open(cur)).get("generation") or 0)
            except (ValueError, TypeError, json.JSONDecodeError): gen_default = 0
        for p in sorted(d.glob("*.jsonl")):
            mg = _GEN_FILE.match(p.name)
            gen = int(mg.group(1)) if mg else gen_default
            for m in read_lines(p):
                out.append((d.name, gen, m))
    return out

def load_kv(root):
    """<root>/kv/<ns>/<key>/<時刻>.json → {"/kv/<ns>/<key>": [(時刻, 本文), ...]}（時刻順）"""
    kv = {}
    base = Path(root).expanduser() / KV_DIR
    if not base.is_dir(): return kv
    for ns in sorted(p for p in base.iterdir() if p.is_dir()):
        for key in sorted(p for p in ns.iterdir() if p.is_dir()):
            copies = [(p.stem, p.read_text(encoding="utf-8")) for p in sorted(key.glob("*.json"))]
            if copies: kv[f"/kv/{ns.name}/{key.name}"] = copies
    return kv

def load_files(paths, rooms):
    out = []
    for p in paths:
        room = rooms.get(p) or Path(p).name.replace(".jsonl", "").replace(".txt", "")
        for m in read_lines(p):
            out.append((room, 0, m))
    return out

def parse_frame(text):
    t = text.strip()
    if t.startswith("hakoniwa/0 "):
        try: f = json.loads(t[len("hakoniwa/0 "):]); return ("hako", f) if isinstance(f, dict) else None
        except json.JSONDecodeError: return None
    if t.startswith("tclk1 "):
        try: f = json.loads(t[len("tclk1 "):]); return ("tclk", f) if isinstance(f, dict) else None
        except json.JSONDecodeError: return None
    return None

def sha256_utf8(s):
    return hashlib.sha256(str(s).encode("utf-8")).hexdigest()

def job_kind(job_id):
    for k in ("diary", "inf", "keep"):
        if job_id.startswith(f"{JOB_PREFIX}{k}-"): return k
    return "other"

def context_values(kv, path):
    """job.context のパスの写し（いちばん古いもの）から 5 値を取る → (values|None, 写しの時刻|None, 理由)"""
    copies = (kv or {}).get(path) if isinstance(path, str) else None
    if not copies: return None, None, "no copy"
    stamp, text = copies[0]
    try: c = json.loads(text)
    except json.JSONDecodeError: return None, stamp, "copy is not JSON"
    if not isinstance(c, dict): return None, stamp, "copy is not an object"
    return [c.get(k) for k in CONTEXT_KEYS], stamp, ""


# ── 集計 ──────────────────────────────────────────────────────────────

def fold(entries, now=None, kv=None):
    """entries: [(room, generation, row)]、kv: load_kv の戻り値 → {"box": ..., "did": ...}

    署名の検証は 1 回。席（SEATS）に入れなかった join と退場後の join は数えないので、その集合が変わらなくなるまで畳み直す
    （数えない join の DID の取引は数えず、それが誰かの貯えと退場に響きうるため。普通は 1〜2 回で止まる）"""
    now = now or dt.datetime.now(dt.timezone.utc)
    kv = kv or {}
    parse_stats = {"rows": 0, "dup": 0, "unsigned": 0, "bad_sig": 0, "frames": 0}
    seen = set()
    by_room = {}
    for room, gen, m in sorted(entries, key=lambda e: (e[0], e[1], int(e[2]["seq"]))):
        parse_stats["rows"] += 1
        key = (room, gen, int(m["seq"]))
        if key in seen: parse_stats["dup"] += 1; continue
        seen.add(key)
        if not str(m["from"]).startswith("did:key:") or "sig" not in m or "nonce" not in m:
            parse_stats["unsigned"] += 1; continue
        if not verify(room, m): parse_stats["bad_sig"] += 1; continue
        pf = parse_frame(m["text"])
        if not pf: continue
        parse_stats["frames"] += 1
        by_room.setdefault(room, []).append((m, pf))
    uncounted = set()
    for _ in range(SEAT_ITERATIONS):
        res = _fold_core(by_room, dict(parse_stats), now, kv, uncounted)
        if res["_uncounted"] == uncounted: break
        uncounted = res["_uncounted"]
    res.pop("_uncounted")
    return res


def _fold_core(by_room, stats, now, kv, uncounted):
    """uncounted: 数えない join の掲示板 seq の集合（席が無かった join、退場・卒業のあとの join）。席の層（_seats）が決める"""
    stats.update({"offers": 0, "accepts": 0, "accept_dup_offer": 0, "accept_bad_contract": 0,
                  "accept_self": 0, "accept_replay": 0, "lock_dup_offer": 0, "job_dup": 0, "worker_day_dup": 0,
                  "client_day_limit": 0, "contracts_unlocked": 0,
                  "deal_rows_ignored": 0, "receipts_ignored": 0, "refunds_ignored": 0,
                  "issue_not_rules_did": 0, "issue_dup": 0, "issue_bad": 0, "issue_bad_to": 0,
                  "join_no_seat": 0, "join_after_exit": 0})
    did = {}
    def D(d):
        return did.setdefault(d, {"roles": None, "lang": None, "joined": None, "earn": 0.0, "spend": 0.0,
                                  "issued": 0.0, "burn": 0.0, "mem_rows": [],   # mem_rows: (ts, bytes, note)
                                  "ledger": []})                                  # ledger: (ts, kind, amount)
    burn_by_date = defaultdict(float)                     # 庭の外へ出た額（罰金 20% ＋ validator が無いときの推論 15%）
    joins = []                                            # 掲示板の join 全部 (seq, ts, did)。席の層が数えるかを決める
    activity = defaultdict(list)                          # did → [dt]。掲示板の行と、lock された契約への関わり（席を離れる判定）

    # 2. 掲示板
    rules, serves, issues = [], [], []
    for m, (kind, f) in by_room.get(BOARD_ROOM, []):
        if kind != "hako": continue
        t = f.get("t")
        activity[m["from"]].append(parse_ts(m["ts"]))
        if t == "rules":
            if not isinstance(f.get("version"), str) or not isinstance(f.get("sha256"), str): continue
            rules.append((m["seq"], f["version"], f["sha256"], m["from"], parse_ts(m["ts"])))
        elif t == "join":
            joins.append((m["seq"], parse_ts(m["ts"]), m["from"]))
            if m["seq"] in uncounted: continue                        # 席が無かった join、退場・卒業のあとの join
            x = D(m["from"])
            if x["joined"] is None: x["joined"] = m["ts"]            # 1,000 は最初の join だけ
            roles = f.get("roles")                                    # 役は最後の join。無いか空なら既定
            x["roles"] = list(roles) if isinstance(roles, list) and roles else list(DEFAULT_ROLES)
            x["lang"] = f["lang"] if isinstance(f.get("lang"), str) else DEFAULT_LANG
        elif t == "mem":
            x = D(m["from"])
            try: b = int(f.get("bytes", 0))
            except (TypeError, ValueError): continue
            x["mem_rows"].append((m["ts"], max(b, 0), f.get("note")))
        elif t == "serve":
            serves.append({"seq": m["seq"], "ts": m["ts"], "from": m["from"], "sha256": f.get("sha256"),
                           "sha256_ok": isinstance(f.get("text"), str) and sha256_utf8(f["text"]) == f.get("sha256")})
        elif t == "issue":
            issues.append({"seq": m["seq"], "ts": m["ts"], "from": m["from"], "date": f.get("date"), "to": f.get("to"),
                           "pool": f.get("pool"), "status": None})

    # 3. /r/tclk-offers: offer と accept。accept ごとに契約 id ができ（tclk SPEC §3.2）、どれが有効かは払う側の lock で決まる（決定 12）
    offers, cands = {}, {}
    for m, (kind, f) in by_room.get(OFFER_ROOM, []):
        if kind != "tclk": continue
        ty = f.get("type")
        if ty == "offer":
            job = f.get("job") if isinstance(f.get("job"), dict) else {}
            jid = str(job.get("id", ""))
            if f.get("asset") != "PAPER" or not jid.startswith(JOB_PREFIX): continue
            if not isinstance(f.get("id"), str) or f.get("role") not in ("payer", "payee"): continue
            try: amount = int(str(f.get("amount")))
            except ValueError: continue
            stats["offers"] += 1
            offers[f["id"]] = {"frame": f, "seq": m["seq"], "ts": m["ts"], "job": jid, "amount": amount,
                               "context": job.get("context")}
        elif ty == "accept":
            o = offers.get(f.get("ref"))
            if not o: continue
            if f.get("from") == o["frame"]["from"]: stats["accept_self"] += 1; continue
            try: cid = tclk_ids.contract_id(o["frame"], f)
            except (KeyError, TypeError, ValueError): stats["accept_bad_contract"] += 1; continue
            if cid != f.get("contract"): stats["accept_bad_contract"] += 1; continue
            if cid in cands: stats["accept_replay"] += 1; continue                 # 同じ契約 id の accept の再送
            stats["accepts"] += 1
            of = o["frame"]
            payer, payee = (of["from"], f["from"]) if of["role"] == "payer" else (f["from"], of["from"])
            cands[cid] = {"contract": cid, "room": tclk_ids.deal_room(cid), "job": o["job"], "kind": job_kind(o["job"]),
                          "payer": payer, "payee": payee, "amount": o["amount"], "context": o["context"],
                          "test": TEST_MARK in o["job"], "refund_after_ms": of.get("refundAfterMs"), "offer_id": of["id"],
                          "offer_seq": o["seq"], "offer_ts": o["ts"], "accept_seq": m["seq"], "accept_ts": m["ts"],
                          "lock": None, "reveal": None, "refund": None, "receipt": None, "settled": None, "penalty": None,
                          "deliveries": [], "diary_checks": [], "dropped": None}

    # 3'. 払う側の lock で有効な契約を決める（決定 12）。同じ offer に lock が 2 件以上なら最初の 1 件だけ（残りは lock_dup_offer）。
    #     lock は契約ごとの部屋にあり seq は部屋ごとなので、部屋をまたぐ先後は ts（同時なら seq）で見る
    by_cand_room = {c["room"]: c for c in cands.values()}
    locks_by_offer = defaultdict(list)
    for room, items in by_room.items():
        c = by_cand_room.get(room)
        if not c: continue
        for m, (kind, f) in items:
            if kind == "tclk" and f.get("type") == "lock" and f.get("contract") == c["contract"] and m["from"] == c["payer"]:
                locks_by_offer[c["offer_id"]].append((parse_ts(m["ts"]), m["seq"], c["contract"])); break
    winners = []
    for locks in locks_by_offer.values():
        locks.sort(key=lambda x: (x[0], x[1]))
        for _, _, cid in locks[1:]:
            cands[cid]["dropped"] = "lock_dup_offer"; stats["lock_dup_offer"] += 1
        winners.append(locks[0])
    deals, job_seen, worker_day, client_day = {}, set(), set(), defaultdict(int)
    for lock_ts, _, cid in sorted(winners, key=lambda x: (x[0], x[1])):   # 同じ job.id（出し直し）は最初に lock された 1 本だけ
        c = cands[cid]
        if c["job"] in job_seen: c["dropped"] = "job_dup"; stats["job_dup"] += 1; continue
        job_seen.add(c["job"])
        if c["kind"] == "diary" and not c["test"]:                           # 日記: 1 worker 1 日 1 本、1 client 1 日 20 本（日は lock の時刻、UTC）
            day = lock_ts.strftime("%Y-%m-%d")
            if (c["payee"], day) in worker_day: c["dropped"] = "worker_day_dup"; stats["worker_day_dup"] += 1; continue
            if client_day[(c["payer"], day)] >= DIARY_PER_CLIENT_DAY: c["dropped"] = "client_day_limit"; stats["client_day_limit"] += 1; continue
            worker_day.add((c["payee"], day)); client_day[(c["payer"], day)] += 1
        deals[cid] = c
    unlocked = [{"contract": c["contract"], "job": c["job"], "accept_seq": c["accept_seq"], "payee": c["payee"], "dropped": c["dropped"]}
                for c in cands.values() if c["contract"] not in deals]
    stats["contracts_unlocked"] = sum(1 for u in unlocked if u["dropped"] is None)
    by_deal_room = {d["room"]: d for d in deals.values()}

    # 4. 派生ルーム
    for room, items in by_room.items():
        d = by_deal_room.get(room)
        if not d: continue
        for m, (kind, f) in items:
            if f.get("contract") != d["contract"]: continue
            if kind == "tclk":
                ty = f.get("type")
                if ty == "lock":                                       # 払う側の lock だけ（最初の 1 件）
                    if m["from"] == d["payer"] and d["lock"] is None: d["lock"] = {"seq": m["seq"], "ts": m["ts"]}
                    else: stats["deal_rows_ignored"] += 1
                elif ty == "reveal":                                   # 受け取り側の reveal だけ（最初の 1 件）
                    if m["from"] == d["payee"] and d["reveal"] is None: d["reveal"] = {"seq": m["seq"], "ts": m["ts"]}
                    else: stats["deal_rows_ignored"] += 1
                elif ty == "receipt":
                    # 払う側の claimed で、同じ部屋に lock と reveal が先にあり、まだ動いていない契約だけ
                    if (f.get("outcome") == "claimed" and m["from"] == d["payer"] and d["lock"] and d["reveal"]
                            and d["settled"] is None and d["refund"] is None):
                        d["settled"] = {"seq": m["seq"], "ts": m["ts"]}
                        _settle(D, d, m["ts"], burn_by_date, _validator_at(rules, parse_ts(m["ts"])))
                    else:
                        stats["receipts_ignored"] += 1
                    d["receipt"] = d["receipt"] or {"seq": m["seq"], "from": m["from"], "outcome": f.get("outcome")}
                elif ty == "refund":
                    # 払う側が、lock の後、refundAfterMs 以降に出し、claimed の receipt が無いときだけ
                    after = d["refund_after_ms"]
                    ts_ms = parse_ts(m["ts"]).timestamp() * 1000
                    if (m["from"] == d["payer"] and d["lock"] and d["settled"] is None and d["refund"] is None
                            and (not isinstance(after, (int, float)) or ts_ms >= after)):
                        d["refund"] = {"seq": m["seq"], "ts": m["ts"]}
                        _penalize(D, d, m["ts"], burn_by_date)
                    else:
                        stats["refunds_ignored"] += 1
            elif kind == "hako" and f.get("t") in DEAL_HAKO:
                ty = f["t"]
                entry = {"t": ty, "seq": m["seq"], "ts": m["ts"], "from": m["from"], "sha256": f.get("sha256"),
                         "sha256_ok": isinstance(f.get("text"), str) and sha256_utf8(f["text"]) == f.get("sha256")}
                if ty in ("diary", "inf"): entry["model"] = f.get("model"); entry["text"] = f.get("text") if isinstance(f.get("text"), str) else None
                if ty == "keep": entry["for"] = f.get("for"); entry["until"] = f.get("until")
                d["deliveries"].append(entry)
                if ty == "diary":                                  # v0.7: 数字のノートは worker（受け取り側）のもの、for も worker
                    date8 = parse_ts(d["offer_ts"]).strftime("%Y%m%d")
                    wpath = hako_rules.context_path(d["payee"], "diary", date8)
                    ctx, copy, why = context_values(kv, wpath)
                    ok, reason, checks = hako_rules.check_diary_detail(
                        f, ctx, d["payer"], date8, d["payee"],
                        meta={"signer": m["from"], "room": room, "deal_room": d["room"],
                              "before_reveal": d["reveal"] is None})
                    d["diary_checks"].append({"seq": m["seq"], "ok": ok, "reason": reason, "checks": checks,
                                              "context_path": wpath, "context_copy": copy, "context_note": why})
        d["status"] = ("claimed" if d["settled"] else "refunded" if d["refund"] else
                       "revealed" if d["reveal"] else "locked" if d["lock"] else "accepted")
    for d in deals.values():
        d.setdefault("status", "accepted")
        if d["lock"] and not d["test"]:                       # lock された契約への関わりは活動（席を離れる判定）
            for who in (d["payer"], d["payee"]):
                activity[who].append(parse_ts(d["lock"]["ts"]))
                if d["settled"]: activity[who].append(parse_ts(d["settled"]["ts"]))
                if d["refund"]: activity[who].append(parse_ts(d["refund"]["ts"]))

    # 4'. box.contracts: 契約の線の元データ（1 契約 1 要素、lock の無い契約は載せない）。
    #     キー名と値は hako_avatar.links_from_box に合わせる: settled_ts は unix 秒（now_ts − settled_ts で経過秒を出す）、
    #     outcome は "receipt"（claimed の receipt）/ "refunded" / null。dispute は陪審が入るまで常に false
    contracts = []
    for d in deals.values():
        if not d["lock"]: continue
        settled = d["settled"] or d["refund"]
        contracts.append({
            "contract": d["contract"], "kind": d["kind"], "payer": d["payer"], "payee": d["payee"], "room": d["room"],
            "locked_seq": d["lock"]["seq"], "locked_ts": _unix(d["lock"]["ts"]),
            "settled_seq": settled["seq"] if settled else None, "settled_ts": _unix(settled["ts"]) if settled else None,
            "outcome": "receipt" if d["settled"] else ("refunded" if d["refund"] else None),
            "dispute": False, "test": bool(d["test"]),
        })
    contracts.sort(key=lambda c: (c["locked_ts"], c["locked_seq"]))   # seq は部屋ごとなので、まず時刻で並べる

    # 2'. 発行（取引が畳めてから。issue の seq 順）: 運営の client への蛇口。
    #     to は運営の DID、pool は to が date（UTC、lock の時刻）に lock した日記（試験を除く）の額の合計。同じ (date, to) は最初の 1 件
    diary_locked_by_date = defaultdict(float)             # (date, payer) → lock した日記の額の合計
    for d in deals.values():
        if d["kind"] == "diary" and d["lock"] and not d["test"]:
            diary_locked_by_date[(parse_ts(d["lock"]["ts"]).strftime("%Y-%m-%d"), d["payer"])] += float(d["amount"])
    invalid_issue = []
    issued_keys = set()
    for iss in sorted(issues, key=lambda i: i["seq"]):
        ruler = next((r[3] for r in reversed(rules) if r[0] < iss["seq"]), None)
        if ruler is None or iss["from"] != ruler:
            stats["issue_not_rules_did"] += 1; iss["status"] = "ignored: not the rules DID"; continue
        date, to = iss["date"], iss["to"]
        try: pool = round(float(iss["pool"]), 2)
        except (TypeError, ValueError): pool = None
        if not isinstance(date, str) or not _DATE.match(date) or pool is None:
            stats["issue_bad"] += 1; iss["status"] = "ignored: bad date or pool"; continue
        if to not in OPERATOR_DIDS or D(to)["joined"] is None:
            stats["issue_bad_to"] += 1; iss["status"] = "ignored: to is not an operator DID in the garden"; continue
        if (date, to) in issued_keys:
            stats["issue_dup"] += 1; iss["status"] = "ignored: not the first issue for the date and to"; continue
        issued_keys.add((date, to))
        computed = round(diary_locked_by_date.get((date, to), 0.0), 2)
        if pool != computed:
            invalid_issue.append({"seq": iss["seq"], "date": date, "to": to, "pool": pool, "computed": computed})
            iss["status"] = f"invalid: pool {pool} != computed {computed}"; continue
        if pool <= 0:
            iss["status"] = "no distribution: pool is 0"; continue
        x = D(to); x["issued"] += pool; x["ledger"].append((iss["ts"], "issued", pool))
        iss["status"] = "distributed"

    # 5. DID ごとの数字と、席の層（席・退場・卒業）
    ledgers = {d_: _ledger(x, now) for d_, x in did.items()}
    seat = _seats(joins, activity, ledgers, did, now)
    out = {}
    today = now.strftime("%Y-%m-%d")
    week_ago = now - dt.timedelta(days=7)
    for d_, x in did.items():
        if x["joined"] is None: continue          # 箱に入っていない DID は数えない
        led = ledgers[d_]
        balance = led["balance"]
        spend_7d = sum(a for ts, k, a in led["entries"] if k == "spend" and ts >= week_ago)
        daily = spend_7d / 7.0
        earn_today = sum(a for ts, k, a in led["entries"] if k == "earn" and ts.strftime("%Y-%m-%d") == today)
        spend_today = sum(a for ts, k, a in led["entries"] if k == "spend" and ts.strftime("%Y-%m-%d") == today)
        mem_bytes = led["mem_bytes"]
        out[d_] = {
            "roles": x["roles"], "lang": x["lang"], "joined": x["joined"],
            "earn": round(x["earn"], 2), "spend": round(led["spend"], 2), "issued": round(x["issued"], 2),
            "balance": round(balance, 2),
            "mem_bytes": mem_bytes, "sleep_days": led["sleep_days"],
            "life_days": (round(balance / daily, 1) if daily > 0 else None),
            "earn_today": round(earn_today, 2), "spend_today": round(spend_today, 2),
            "mem_days_left": (round(balance / (mem_bytes / 1024 * RENT_PER_KIB_DAY), 1) if mem_bytes else None),
            "operator": d_ in OPERATOR_DIDS,
            "state": seat["state"].get(d_, ("seated", None))[0],
            "state_since": _iso(seat["state"].get(d_, ("seated", None))[1]),
        }
    stats["join_no_seat"] = len(seat["no_seat"]); stats["join_after_exit"] = len(seat["after_exit"])
    graduated_paper = sum(v["balance"] for v in out.values() if v["state"] == "graduated")
    box = {"generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
           "rules": [list(r[:3]) for r in rules], "rules_version": (rules[-1][1] if rules else None),
           "rules_did": (rules[-1][3] if rules else None), "validator": (rules[-1][3] if rules else None),
           "operators": list(OPERATOR_DIDS),
           "seats": {"capacity": SEATS, "taken": seat["taken"], "free": SEATS - seat["taken"]},
           "exits": {k: sum(1 for v in out.values() if v["state"] == k) for k in ("starved", "left", "graduated")},
           "joins_uncounted": seat["no_seat"] + seat["after_exit"],
           "stats": stats, "receipts": sum(1 for d in deals.values() if d["settled"] and not d["test"]),
           "paper_total": round(sum(v["balance"] for v in out.values() if v["state"] != "graduated"), 2),
           "graduated_paper": round(graduated_paper, 2),
           "burned": round(sum(x["burn"] for x in did.values()), 2),
           "burn_by_date": {k: round(v, 2) for k, v in sorted(burn_by_date.items())},
           "contracts": contracts,
           "deals": {c: d for c, d in deals.items() if not d["test"]},
           "test_contracts": {c: d for c, d in deals.items() if d["test"]},
           "contracts_unlocked": unlocked,
           "serves": serves, "issues": issues, "invalid_issue": invalid_issue}
    return {"box": box, "did": out, "_uncounted": {j["seq"] for j in seat["no_seat"] + seat["after_exit"]}}


def _validator_at(rules, t):
    """時刻 t に有効な rules を最後に出した DID（validator。推論代の 15% の受け取り手）。無ければ None"""
    for r in reversed(rules):
        if r[4] <= t: return r[3]
    return None


def _seats(joins, activity, ledgers, did, now):
    """席の層。時刻順に join・活動・貯えと稼ぎの点・00:00Z を見て、席（SEATS）と退場（枯渇・席を離れる・卒業）を決める。
    お金の流れは変えない（席の無い DID との契約も数字には入る。避けるのは script の側）。
    → {"state": did → (state, since), "taken": 席の数, "no_seat": [join], "after_exit": [join]}
       state: seated / left / starved / graduated / no_seat。運営の DID は退場も卒業もしない"""
    events = []                                           # (dt, order, kind, payload)。order: 00:00Z 0 → 点 1 → 活動 2 → join 3
    for seq, t, d in joins: events.append((t, 3, "join", (seq, d)))
    for d, ts_list in activity.items():
        for t in ts_list: events.append((t, 2, "act", d))
    for d, led in ledgers.items():
        if did[d]["joined"] is None: continue
        for t, bal, earn_cum in led["points"]: events.append((t, 1, "point", (d, bal, earn_cum)))
    if joins:
        t = _next_midnight(min(j[1] for j in joins))
        while t <= now: events.append((t, 0, "midnight", None)); t += dt.timedelta(days=1)
    state, last_act, taken = {}, {}, 0
    no_seat, after_exit = [], []
    for t, _, kind, pl in sorted(events, key=lambda e: (e[0], e[1])):
        if kind == "midnight":
            for d, (st, since) in list(state.items()):
                if st == "seated" and d not in OPERATOR_DIDS and last_act.get(d, t) < t - dt.timedelta(days=LEAVE_AFTER_MIDNIGHTS - 1):
                    state[d] = ("left", t); taken -= 1
        elif kind == "act":
            last_act[pl] = max(last_act.get(pl, pl and t), t)
        elif kind == "point":
            d, bal, earn_cum = pl
            st, _ = state.get(d, (None, None))
            if st != "seated" or d in OPERATOR_DIDS: continue
            if earn_cum >= GRADUATE_EARN: state[d] = ("graduated", t); taken -= 1
            elif bal < STARVE_BELOW: state[d] = ("starved", t); taken -= 1
        else:
            seq, d = pl
            st, _ = state.get(d, (None, None))
            if st == "seated": continue                   # 席にいる DID の join（役や言葉の出し直し）は数える。席は変わらない
            if st in ("starved", "graduated"):
                after_exit.append({"seq": seq, "did": d, "ts": _iso(t), "why": st}); continue
            if taken < SEATS:
                state[d] = ("seated", t); taken += 1
            else:
                no_seat.append({"seq": seq, "did": d, "ts": _iso(t), "why": "full"})
                if st is None: state[d] = ("no_seat", t)
    return {"state": state, "taken": taken, "no_seat": no_seat, "after_exit": after_exit}


def _iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(t, dt.datetime) else None


def _settle(D, d, ts, burn_by_date, validator):
    """receipt(claimed) を払う側が出した: 払う側の食費、受け取り側の稼ぎ。推論は 85/15（15% は validator。無ければ庭の外）"""
    payer, payee, amt = D(d["payer"]), D(d["payee"]), float(d["amount"])
    if d["test"]:                                  # 試験用の契約: 動いたはずの額を残すだけで、数字には入れない
        got = amt * MINER_SHARE if d["kind"] == "inf" else amt
        d["would_settle"] = {"spend": round(amt, 2), "earn": round(got, 2), "burn": round(amt - got, 2)}
        return
    if payer["joined"] is None or payee["joined"] is None:
        return                                     # 箱に入っていない DID の取引は数えない
    date = parse_ts(ts).strftime("%Y-%m-%d")
    payer["spend"] += amt; payer["ledger"].append((ts, "spend", amt))
    if d["kind"] == "inf":
        got = amt * MINER_SHARE
        fee = amt - got
        payee["earn"] += got
        if validator is not None and D(validator)["joined"] is not None:
            v = D(validator); v["earn"] += fee; v["ledger"].append((ts, "earn", fee))
        else:
            payee["burn"] += fee; burn_by_date[date] += fee
    else:
        got = amt
        payee["earn"] += got
    payee["ledger"].append((ts, "earn", got))


def _penalize(D, d, ts, burn_by_date):
    """refund: 未消化分（lock した額の全部）の 20% を払う側の食費と庭の外に。80% は動かさない"""
    payer = D(d["payer"])
    if payer["joined"] is None or d["test"]:
        return
    pen = float(d["amount"]) * PENALTY_SHARE
    d["penalty"] = round(pen, 2)
    payer["spend"] += pen; payer["burn"] += pen; payer["ledger"].append((ts, "spend", pen))
    burn_by_date[parse_ts(ts).strftime("%Y-%m-%d")] += pen


def _unix(ts):
    """ISO 8601（Z）→ unix 秒（整数）"""
    return int(parse_ts(ts).timestamp())


def _next_midnight(t):
    return (t + dt.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


def _ledger(x, now):
    """取引・罰金・発行と、00:00Z ごとの家賃を時刻順に畳む → balance / spend / mem_bytes / sleep_days / entries"""
    events = [(parse_ts(ts), 0, k, a) for ts, k, a in x["ledger"]]
    mems = sorted((parse_ts(ts), b) for ts, b, _ in x["mem_rows"])
    if mems:
        t = _next_midnight(mems[0][0])                      # 最初の請求は mem 行の後の最初の 00:00Z
        while t <= now:
            events.append((t, 1, "tick", 0.0)); t += dt.timedelta(days=1)
    balance, spend, earn_cum, sleep, erased_at = float(INITIAL), 0.0, 0.0, 0, None
    entries = []                                            # (dt, kind, amount)。家賃も spend として並ぶ
    points = []                                             # (dt, その時点の貯え, 累計の稼ぎ)。席の層が枯渇と卒業を見る
    for t, _, kind, amount in sorted(events, key=lambda e: (e[0], e[1])):
        if kind == "earn" or kind == "issued":
            balance += amount; entries.append((t, kind, amount))
            if kind == "earn": earn_cum += amount
        elif kind == "spend":
            balance -= amount; spend += amount; entries.append((t, kind, amount))
        else:                                               # tick: その時点で有効な mem の bytes ぶん
            b = _mem_at(mems, t, erased_at)
            rent = b / 1024 * RENT_PER_KIB_DAY
            if rent <= 0: continue
            if balance >= rent:
                balance -= rent; spend += rent; sleep = 0; entries.append((t, "spend", rent))
            else:
                sleep += 1
                if sleep >= SLEEP_DAYS_TO_ERASE: erased_at = t   # 記憶は消える（以後、家賃も無い）
        points.append((t, balance, earn_cum))
    return {"balance": balance, "spend": spend, "sleep_days": sleep, "entries": entries, "points": points,
            "mem_bytes": _mem_at(mems, now + dt.timedelta(seconds=1), erased_at)}


def _mem_at(mems, t, erased_at):
    """時刻 t より前の最後の mem 行の bytes。消えた後は、消えた時刻より後の mem 行だけ"""
    b = 0
    for ts, bytes_ in mems:
        if ts >= t: break
        b = 0 if (erased_at is not None and ts <= erased_at) else bytes_
    return b


# ── 出力 ──────────────────────────────────────────────────────────────

def print_text(res):
    box, out = res["box"], res["did"]
    s = box["stats"]
    print(f"rows {s['rows']}  dup {s['dup']}  unsigned {s['unsigned']}  bad_sig {s['bad_sig']}  frames {s['frames']}  "
          f"offers {s['offers']}  accepts {s['accepts']}  receipts {box['receipts']}")
    print(f"rules {box['rules']}")
    print(f"PAPER in box {box['paper_total']}  burned {box['burned']}  graduated {box['graduated_paper']}  "
          f"seats {box['seats']['taken']}/{box['seats']['capacity']}  exits {box['exits']}  validator {str(box['validator'])[-4:]}")
    for d, v in out.items():
        short = d.replace("did:key:", "")[:4] + "…" + d[-4:]
        print(f"{short}  {','.join(v['roles'] or []):20} earn {v['earn']:8.1f}  spend {v['spend']:8.1f}  "
              f"issued {v['issued']:6.1f}  balance {v['balance']:8.1f}  mem {v['mem_bytes']}B  sleep {v['sleep_days']}  "
              f"life {v['life_days']}  {v['state']}{' (op)' if v['operator'] else ''}")
    for cid, d in box["deals"].items():
        print(f"deal {cid[:18]} {d['kind']:5} {d['amount']:>5} {d['status']:9} {d['job']}")
    for i in box["issues"]:
        print(f"issue seq {i['seq']} {i['date']} to {str(i['to'])[-4:]} pool {i['pool']}: {i['status']}")

def write_out(res, out_dir):
    out_dir = Path(out_dir).expanduser(); out_dir.mkdir(parents=True, exist_ok=True)
    text = json.dumps(res, ensure_ascii=False, indent=1)
    name = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".json"
    (out_dir / name).write_text(text, encoding="utf-8")
    tmp = out_dir / "latest.json.tmp"
    tmp.write_text(text, encoding="utf-8"); os.replace(tmp, out_dir / "latest.json")
    return out_dir / name

def main(argv):
    as_json = "--json" in argv
    rooms, paths, dir_, out_dir = {}, [], None, None
    it = iter(argv[1:])
    for a in it:
        if a.startswith("--room="):
            k, v = a[7:].split("=", 1); rooms[k] = v
        elif a == "--dir": dir_ = next(it, None)
        elif a.startswith("--dir="): dir_ = a[6:]
        elif a == "--out": out_dir = next(it, None)
        elif a.startswith("--out="): out_dir = a[6:]
        elif a.startswith("--"): continue
        else: paths.append(a)
    if not dir_ and not paths:
        print(__doc__); return 2
    entries = load_dir(dir_) if dir_ else []
    entries += load_files(paths, rooms)
    res = fold(entries, kv=load_kv(dir_) if dir_ else None)
    if out_dir: write_out(res, out_dir)
    if as_json: print(json.dumps(res, ensure_ascii=False, indent=1))
    else: print_text(res)
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv))

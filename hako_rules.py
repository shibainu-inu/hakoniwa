#!/usr/bin/env python3
"""hako_rules.py — HAKONIWA-RULES.md v0.7「日記の合格条件」（DECISIONS 決定 9、14）の機械判定と、context ノートのパス。

    from hako_rules import check_diary, context_path
    ok, reason = check_diary(diary_frame, context_values, client_did, date_yyyymmdd, worker_did, meta=None)
      v0.7: worker が自分の日記を書くので、条件 2 の for は worker の DID、条件 4 の context は worker のノートの 5 値（client_did は記録用）
    context_path(did, "diary", "20260909")  → "/kv/hakoniwa-<DID 末尾 8 文字を小文字>/diary-20260909"
    context_path(did, "inf", "6cfafe51-1")  → "/kv/hakoniwa-<DID 末尾 8 文字を小文字>/inf-6cfafe51-1"
      Technocore の名前空間は小文字・数字・-・_ のみ（大文字は 400）なので、末尾 8 文字は小文字にする（決定 11）
    personality(pubkey_bytes) → {"work": -8..7, "keep": -8..7, "words": {"ja": [...], "en": [...]}}   （決定 13）
      公開鍵 32 バイトの 2 バイト目が「受ける」、3 バイト目が「憶える」（0 始まり。0 が色、1 が飾り）。各 (byte mod 16) − 8。
      2 語への写像は符号だけ: 受ける + 「よく働く」/ − 「のんびり」、憶える + 「思い出を残したがる」/ − 「忘れっぽい」、0 は無し。
      英語は hard-working / easygoing、keeps memories / forgetful
    python3 hako_rules.py personality <did:key>   → 上の JSON

    python3 hako_rules.py check-diary <json>      # <json> は下の入力。"-" なら標準入力
    → 標準出力に {"ok": true|false|null, "reason": "...", "checks": {"1": ..., ..., "5": ...}}

入力 JSON:
    {"diary": {...hakoniwa/0 の diary 行の JSON...},
     "context": [earn, spend, balance, mem_bytes, life_days],   # context ノートの 5 値。未取得なら null
     "client": "did:key:...", "date": "20260909" または "2026-09-09", "worker": "did:key:...",
     "meta": {"signer": "did:key:...", "room": "mb-p-tclk-...", "deal_room": "mb-p-tclk-...", "before_reveal": true}}

5 条件（ルールの表そのまま）:
    1 行の場所と順と署名者 … diary 行が取引の部屋にあり、reveal より前で、署名者が lock された契約の worker の DID（決定 12）
      （部屋・順・署名者は行の外側の情報なので meta で受け取る。meta に無い項目は判定できず、ok は null）
    2 宛先と日付 … for ＝ client の DID、date ＝ offer を出した日（UTC）
    3 長さ … \\uXXXX を戻したあとの本文が 140 文字以内（コードポイント）
    4 数字を変えていない … 本文中の数字の並び（[0-9]+ に小数点つきの続きを含める。17.6 は 1 つ。全角数字は半角化）を全部取り出し、
      その全部が context の 5 値のどれかと文字列で完全一致。数字が 1 つも無ければ合格。
      context が null で数字があれば判定できず、ok は null
    5 空でない … 本文が空白だけではない

ok は True（5 つ全部通過）/ False（1 つでも不合格）/ None（不合格は無いが判定できない条件がある）。
reason は不合格・未判定の条件を "N:理由" で列挙（空文字なら全部通過）。
漢数字は数字として扱わない（ルールの限界）。小数点・カンマ・符号は数字の並びを区切る文字として扱う（"1,051" は "1" と "051"）。
"""
import hashlib
import json
import re
import sys

MAX_CHARS = 140
NOTE_NS_PREFIX = "hakoniwa-"
_FULLWIDTH = str.maketrans("０１２３４５６７８９", "0123456789")
_DIGITS = re.compile(r"[0-9]+(?:\.[0-9]+)?")   # 小数点を含めて 1 つの数字（余命 17.6 など。2026-09-13）


def context_path(did, kind, suffix):
    """仕事の context ノートのパス。/kv/hakoniwa-<DID 末尾 8 文字を小文字>/<kind>-<suffix>"""
    return f"/kv/{NOTE_NS_PREFIX}{str(did)[-8:].lower()}/{kind}-{suffix}"


def diary_context_path(worker_did, client_did, date8):
    """日記の数字のノート（決定 31）。置くのは worker、中身は**払った側（client）の数字**。
    1 日に何人ぶんも書くので、パスに client の末尾 8 文字を入れて分ける"""
    return context_path(worker_did, "diary", f"{date8}-{str(client_did)[-8:].lower()}")


PERSONALITY_WORDS = {
    "ja": {"work": ("よく働く", "のんびり"), "keep": ("思い出を残したがる", "忘れっぽい")},
    "en": {"work": ("hard-working", "easygoing"), "keep": ("keeps memories", "forgetful")},
}


def personality(pubkey_bytes):
    """公開鍵 32 バイト → 性格（決定 13）。2 バイト目が「受ける」(work)、3 バイト目が「憶える」(keep)。各 (byte mod 16) − 8。
    2 語への写像は符号だけ（+ / −）。0 はその語を書かない"""
    b = bytes(pubkey_bytes)
    if len(b) != 32:
        raise ValueError(f"ed25519 public key must be 32 bytes, got {len(b)}")
    work, keep = (b[2] % 16) - 8, (b[3] % 16) - 8
    words = {}
    for lang, table in PERSONALITY_WORDS.items():
        out = []
        for key, v in (("work", work), ("keep", keep)):
            if v > 0: out.append(table[key][0])
            elif v < 0: out.append(table[key][1])
        words[lang] = out
    return {"work": work, "keep": keep, "words": words}


# 乱数（決定 19。ルール v0.12「乱数で揺れるのは…」）。既定は hako_box.json の random_accept_pct / random_keep_pct
ACCEPT_PCT, KEEP_PCT = 55, 15


def probabilities(pubkey_bytes, accept_pct=None, keep_pct=None):
    """公開鍵 → 3 つの確率（%）。性格のポイントを「受ける」「憶える」に足し、同じ分を「休む」で打ち消す（合計 100）"""
    pe = personality(pubkey_bytes)
    work = (ACCEPT_PCT if accept_pct is None else int(accept_pct)) + pe["work"]
    keep = (KEEP_PCT if keep_pct is None else int(keep_pct)) + pe["keep"]
    return {"work": work, "keep": keep, "rest": 100 - work - keep}


def choose(pubkey_bytes, turn_id, accept_pct=None, keep_pct=None):
    """その手番の行動を決める（決定 19）。誰でも同じ結果を出せる:
      seed = sha256(公開鍵 32 バイト ‖ b"|" ‖ turn_id の UTF-8) の先頭バイト（0〜255）
      しきい値 = 確率 × 256 // 100 を「受ける」「憶える」の順に積む。残り（端数を含む）が「休む」
    turn_id は手番の識別子。受けるなら日記 offer の id、憶えるなら預かりの job.id。
    掲示板の seq は入れない: 同じ offer に何度も引き直せてしまい「休む」が効かなくなるため"""
    b = bytes(pubkey_bytes)
    p = probabilities(b, accept_pct, keep_pct)
    byte = hashlib.sha256(b + b"|" + str(turn_id).encode("utf-8")).digest()[0]
    cut_work = p["work"] * 256 // 100
    cut_keep = cut_work + p["keep"] * 256 // 100
    action = "work" if byte < cut_work else ("keep" if byte < cut_keep else "rest")
    return {"action": action, "byte": byte, "cut_work": cut_work, "cut_keep": cut_keep, "p": p}


# ── 一言（決定 20。ルール v0.13「一言」） ──
WORDS_PATH = None   # None なら hako_rules.py と同じ場所の hako_words.json（HAKO_WORDS で変えられる）


def _load_words():
    import os, pathlib
    p = pathlib.Path(WORDS_PATH or os.environ.get("HAKO_WORDS") or pathlib.Path(__file__).resolve().parent / "hako_words.json")
    return json.loads(p.read_bytes().decode("utf-8"))


def did_base58(did):
    """did:key:z…… の z のあとの base58。語彙はこの文字の在庫から作る（公開鍵そのものの表記）"""
    d = str(did)
    i = d.find("z")
    if not d.startswith("did:key:") or i < 0:
        raise ValueError("not a did:key")
    return d[i + 1:]


def vocabulary(did, words=None):
    """その DID の語彙（決定 20）。base58 の文字の在庫（同じ文字は出てくる回数まで、小文字に畳む）で
    つづれる英語の語だけ。一覧の順は保つ。DID の一生ぶん変わらない"""
    from collections import Counter
    have = Counter(did_base58(did).lower())
    pairs = (words or _load_words())["words"]
    return [tuple(w) for w in pairs if not (Counter(w[0]) - have)]


GREET_HOURS = (("morning", 5, 11), ("day", 11, 17), ("evening", 17, 22), ("night", 22, 5))


def greet_key(hour_utc):
    """挨拶の種類（UTC の時刻。掲示板の ts から誰でも同じものを出せる）"""
    h = int(hour_utc) % 24
    for key, a, b in GREET_HOURS:
        if a <= b:
            if a <= h < b: return key
        elif h >= a or h < b: return key
    return "day"


def chat(did, turn_id, hour_utc, lang="en", words=None):
    """一言（決定 20）: 挨拶 ＋ 自分の語彙から 2 語。語は乱数と同じ引き方で選ぶ:
      sha256(公開鍵の base58 ‖ "|" ‖ turn_id) の 1 バイト目と 2 バイト目を語彙の長さで割った余り（同じなら次の語）"""
    w = words or _load_words()
    vocab = vocabulary(did, w)
    key = greet_key(hour_utc)
    g = w["greet"][key][lang if lang in ("en", "ja") else "en"]
    if not vocab:
        return {"text": g, "greet": key, "words": []}
    h = hashlib.sha256(did_base58(did).encode("ascii") + b"|" + str(turn_id).encode("utf-8")).digest()
    i = h[0] % len(vocab)
    j = h[1] % len(vocab)
    if j == i: j = (j + 1) % len(vocab)
    picked = [vocab[i], vocab[j]] if j != i else [vocab[i]]
    idx = 0 if lang != "ja" else 1
    body = ("、".join(p[1] for p in picked) + "。") if lang == "ja" else (", ".join(p[idx] for p in picked) + ".")
    return {"text": f"{g} {body}", "greet": key, "words": [p[idx] for p in picked]}


def pubkey_from_did(did):
    """did:key:z6Mk… → Ed25519 公開鍵 32 バイト（0xed01 ＋ 32 バイトの base58btc）"""
    import base58
    raw = base58.b58decode(str(did).removeprefix("did:key:z"))
    if raw[:2] != b"\xed\x01" or len(raw) != 34:
        raise ValueError("not an ed25519 did:key")
    return raw[2:]


def _date8(s):
    return str(s).replace("-", "")


def _context_strings(context_values):
    out = []
    for v in context_values:
        if v is None or isinstance(v, bool):
            continue
        out.append(v if isinstance(v, str) else json.dumps(v))
    return out


def check_diary(diary_frame, context_values, client_did, date_yyyymmdd, worker_did, meta=None):
    """→ (ok, reason)。詳細は check_diary_detail。"""
    ok, reason, _ = check_diary_detail(diary_frame, context_values, client_did, date_yyyymmdd, worker_did, meta)
    return ok, reason


def check_diary_detail(diary_frame, context_values, client_did, date_yyyymmdd, worker_did, meta=None):
    """→ (ok, reason, checks)。checks は {"1": True|False|None, ...}。"""
    f = diary_frame if isinstance(diary_frame, dict) else {}
    meta = meta or {}
    checks, fails, unknown = {}, [], []

    # 1. 行の場所と順と署名者
    c1_parts, c1_unknown = [], []
    signer = meta.get("signer")
    if signer is None:
        c1_unknown.append("signer unknown")
    elif signer != worker_did:
        c1_parts.append("signer is not the worker of the locked contract")
    room, deal_room = meta.get("room"), meta.get("deal_room")
    if room is None or deal_room is None:
        c1_unknown.append("room unknown")
    elif room != deal_room:
        c1_parts.append("not in the deal room")
    before = meta.get("before_reveal")
    if before is None:
        c1_unknown.append("order unknown")
    elif not before:
        c1_parts.append("after reveal")
    if f.get("t") != "diary":
        c1_parts.append("not a diary line")
    if c1_parts:
        checks["1"] = False; fails.append("1:" + ", ".join(c1_parts))
    elif c1_unknown:
        checks["1"] = None; unknown.append("1:" + ", ".join(c1_unknown))
    else:
        checks["1"] = True

    # 2. 宛先と日付（決定 31: 日記は払った側のもの。for は client）
    c2 = []
    if f.get("for") != client_did:
        c2.append("for is not the client")
    if _date8(f.get("date", "")) != _date8(date_yyyymmdd):
        c2.append("date is not the offer day")
    checks["2"] = not c2
    if c2:
        fails.append("2:" + ", ".join(c2))

    text = f.get("text")
    text = text if isinstance(text, str) else ""

    # 3. 長さ（json.loads 済みの文字列なので \uXXXX は戻っている。len はコードポイント）
    checks["3"] = len(text) <= MAX_CHARS
    if not checks["3"]:
        fails.append(f"3:{len(text)} chars > {MAX_CHARS}")

    # 4. 数字を変えていない
    digits = _DIGITS.findall(text.translate(_FULLWIDTH))
    if not digits:
        checks["4"] = True
    elif context_values is None:
        checks["4"] = None; unknown.append("4:context unknown")
    else:
        allowed = set(_context_strings(context_values))
        bad = sorted({d for d in digits if d not in allowed})
        checks["4"] = not bad
        if bad:
            fails.append("4:numbers not in context: " + " ".join(bad))

    # 5. 空でない
    checks["5"] = bool(text.strip())
    if not checks["5"]:
        fails.append("5:empty")

    if fails:
        return False, "; ".join(fails), checks
    if unknown:
        return None, "; ".join(unknown), checks
    return True, "", checks


def _load_box_pcts():
    """CLI から呼ばれたとき、同じ場所の hako_box.json（HAKO_BOX で変えられる）の確率を使う（決定 16 と 19）"""
    global ACCEPT_PCT, KEEP_PCT
    import os, pathlib
    p = pathlib.Path(os.environ.get("HAKO_BOX") or pathlib.Path(__file__).resolve().parent / "hako_box.json")
    try:
        cfg = json.loads(p.read_bytes().decode("utf-8"))
        ACCEPT_PCT = int(cfg.get("random_accept_pct", ACCEPT_PCT)); KEEP_PCT = int(cfg.get("random_keep_pct", KEEP_PCT))
    except Exception:
        pass


def main(argv):
    _load_box_pcts()
    if len(argv) >= 3 and argv[1] == "personality":
        print(json.dumps(personality(pubkey_from_did(argv[2])), ensure_ascii=False)); return 0
    if len(argv) >= 3 and argv[1] == "vocabulary":
        print(json.dumps([w[0] for w in vocabulary(argv[2])], ensure_ascii=False)); return 0
    if len(argv) >= 5 and argv[1] == "chat":
        print(json.dumps(chat(argv[2], argv[3], int(argv[4]), argv[5] if len(argv) > 5 else "en"), ensure_ascii=False)); return 0
    if len(argv) >= 4 and argv[1] == "choose":
        print(json.dumps(choose(pubkey_from_did(argv[2]), argv[3]), ensure_ascii=False)); return 0
    if len(argv) < 3 or argv[1] != "check-diary":
        print(__doc__); return 2
    raw = sys.stdin.read() if argv[2] == "-" else argv[2]
    inp = json.loads(raw)
    ok, reason, checks = check_diary_detail(inp.get("diary"), inp.get("context"), inp.get("client"),
                                            inp.get("date"), inp.get("worker"), inp.get("meta"))
    print(json.dumps({"ok": ok, "reason": reason, "checks": checks}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

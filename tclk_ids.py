"""tclk/1 の id 計算を Python に写したもの（hakoniwa_fold.py の部品）。

元: flop-labs/tclk 5cc4ab9
  src/frames.ts  canonicalJson / toAscii / domainHash / offerId / contractId
  src/technocore.ts  dealRoom

決まり:
  canonicalJson … キーをソート、区切りなし（compact）、undefined は落とす
  toAscii       … U+0080..U+FFFF を \\uXXXX（小文字 hex、4 桁）に
  domainHash    … sha256("FLOP::tclk::v1|<tag>|<toAscii(canonicalJson)>")
  offerId       … tag "offer"、offer から id を除いたもの
  contractId    … tag "contract"、{"offer": <id 込みの offer>, "accept": <AcceptCore>}
  AcceptCore    … from, ref, statement, paymentKey(あれば), nonce
  dealRoom      … "mb-p-tclk-" + contract[2:18]
"""

import hashlib
import json
import re

TCLK_PREFIX = "tclk1 "
TCLK_DOMAIN = "FLOP::tclk::v1"
_CONTRACT_ID = re.compile(r"^0x[0-9a-f]{64}$")


def canonical_json(value) -> str:
    if value is None or not isinstance(value, (dict, list)):
        # JSON.stringify と同じ: 文字列は ensure_ascii=False で書き、後で toAscii する
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    keys = sorted(k for k in value.keys() if value[k] is not None)
    return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical_json(value[k]) for k in keys) + "}"


def to_ascii(s: str) -> str:
    return re.sub(r"[\u0080-\uffff]", lambda m: "\\u%04x" % ord(m.group(0)), s)


def domain_hash(tag: str, payload: str) -> str:
    msg = f"{TCLK_DOMAIN}|{tag}|{to_ascii(payload)}".encode("utf-8")
    return "0x" + hashlib.sha256(msg).hexdigest()


def offer_id(offer: dict) -> str:
    fields = {k: v for k, v in offer.items() if k != "id"}
    return domain_hash("offer", canonical_json(fields))


def accept_core(accept: dict) -> dict:
    core = {"from": accept["from"], "ref": accept["ref"], "statement": accept["statement"], "nonce": accept["nonce"]}
    if accept.get("paymentKey") is not None:
        core["paymentKey"] = accept["paymentKey"]
    return core


def contract_id(offer: dict, accept: dict) -> str:
    return domain_hash("contract", canonical_json({"offer": offer, "accept": accept_core(accept)}))


def deal_room(contract: str) -> str:
    if not _CONTRACT_ID.match(contract):
        raise ValueError(f"malformed contract id: {contract}")
    return "mb-p-tclk-" + contract[2:18]


def decode_frame(text: str):
    """部屋の 1 行から tclk フレーム（dict）を取り出す。tclk 行でなければ None。"""
    if not text.startswith(TCLK_PREFIX):
        return None
    try:
        v = json.loads(text[len(TCLK_PREFIX):])
    except ValueError:
        return None
    return v if isinstance(v, dict) and isinstance(v.get("type"), str) else None


if __name__ == "__main__":
    import sys
    vec = json.load(open(sys.argv[1]))
    offer = decode_frame(vec["offerLine"])
    accept = decode_frame(vec["acceptLine"])
    assert offer_id(offer) == offer["id"], ("offerId 不一致", offer_id(offer), offer["id"])
    cid = contract_id(offer, accept)
    assert cid == vec["contract"] == accept["contract"], ("contractId 不一致", cid, vec["contract"])
    assert deal_room(cid) == vec["room"], ("dealRoom 不一致", deal_room(cid), vec["room"])
    # 9/4 の実ディール（tclk/README.md）: contract 0x6cfafe514dde1703… → /r/mb-p-tclk-6cfafe514dde1703
    assert deal_room("0x6cfafe514dde170319d54f0b4f6819b4d5f3fb688cd6d1f1ae916b68b883b7ae") == "mb-p-tclk-6cfafe514dde1703"
    print("ok: offerId, contractId, dealRoom が公式ライブラリのベクトルと 9/4 の実ディールに一致")

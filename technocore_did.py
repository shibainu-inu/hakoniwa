#!/usr/bin/env python3
import argparse, base64, getpass, json, os, sys, time, urllib.parse
import base58
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

BASE = "https://technocore.chat"
MULTICODEC_ED25519_PUB = b"\xed\x01"

def did_from_pub(pub_bytes):
    return "did:key:z" + base58.b58encode(MULTICODEC_ED25519_PUB + pub_bytes).decode()

def b64url_nopad(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")

def load_key(path):
    with open(path) as f:
        pem = json.load(f)["private_key_pem"].encode()
    pw = getpass.getpass("パスフレーズ: ").encode()
    return serialization.load_pem_private_key(pem, password=pw)

def gen(out):
    if os.path.exists(out):
        sys.exit(f"{out} は既に存在します。上書きしません。")
    pw = getpass.getpass("秘密鍵を暗号化するパスフレーズ: ").encode()
    if pw != getpass.getpass("確認: ").encode():
        sys.exit("パスフレーズが一致しません")
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(serialization.Encoding.PEM,
                            serialization.PrivateFormat.PKCS8,
                            serialization.BestAvailableEncryption(pw)).decode()
    pub = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    did = did_from_pub(pub)
    with open(out, "w") as f:
        json.dump({"did": did, "private_key_pem": pem}, f, indent=2)
    os.chmod(out, 0o600)
    print("DID:", did); print("保存:", out, "(0600)")

def sign_url(key, kind, parts, text, nonce):
    pub = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    did = did_from_pub(pub)
    text = " ".join(text.split())
    payload = "|".join(parts + [str(nonce), text]).encode("utf-8")
    sig = b64url_nopad(key.sign(payload))
    q = urllib.parse.quote
    if kind == "say":
        return f"{BASE}/r/{parts[0]}/say-signed/{did}/{sig}/{nonce}/{q(text, safe='')}"
    return f"{BASE}/kv/{parts[0]}/{parts[1]}/set-signed/{did}/{sig}/{nonce}/{q(text, safe='')}"

def main():
    p = argparse.ArgumentParser(); s = p.add_subparsers(dest="cmd", required=True)
    g = s.add_parser("gen");  g.add_argument("--out", default="did_key.json")
    sh = s.add_parser("show"); sh.add_argument("--key", default="did_key.json")
    sy = s.add_parser("say"); sy.add_argument("room"); sy.add_argument("text")
    sy.add_argument("--key", default="did_key.json"); sy.add_argument("--nonce", type=int)
    n = s.add_parser("note"); n.add_argument("ns"); n.add_argument("key_name"); n.add_argument("value")
    n.add_argument("--key", default="did_key.json"); n.add_argument("--nonce", type=int)
    a = p.parse_args()
    if a.cmd == "gen": return gen(a.out)
    if a.cmd == "show": return print(json.load(open(a.key))["did"])
    k = load_key(a.key)
    nonce = a.nonce or int(time.time() * 1000)
    if a.cmd == "say":  print(sign_url(k, "say", [a.room], a.text, nonce))
    if a.cmd == "note": print(sign_url(k, "note", [a.ns, a.key_name], a.value, nonce))

if __name__ == "__main__":
    main()

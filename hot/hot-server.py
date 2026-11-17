#!/usr/bin/env python3
"""HOT (online) machine: a local web page in front of the hot scripts.

    python3 hot/hot-server.py --dir mainnet --socket /tmp/mainnet.socket [--network mainnet|preprod]
                              [--validator FILE.plutus] [--cli PATH] [--port 8765]

Open the URL it prints (it carries a one-time token after the #). The page receives the datum, cold address and
witnesses from the cold page (camera, dropped file or paste), shows the transactions as QR codes, and submits after
you type SUBMIT. All the Cardano work is done by the scripts in hot/ (build-register.sh, build-deregister.sh,
assemble-submit.sh, build-move-cnight.sh, submit-move-cnight.sh), run with fixed arguments in --dir, the folder that holds payment.addr
and payment.skey. This server never reads payment.skey; it only passes its path to the scripts.

Only 127.0.0.1 can connect. Every API call needs the token, and requests whose Host or Origin is not this server are
refused, so other web pages open in the same browser cannot drive it.
"""
import argparse
import hashlib
import http.server
import json
import os
import re
import secrets
import subprocess
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PAGE = os.path.join(HERE, "hot-page.html")

CNIGHT = {"mainnet": "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa",
          "preprod": "d2dbff622e509dda256fedbd31ef6e9fd98ed49ad91d5c0e07f68af1"}
MAINNET_VALIDATOR = "73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5"
TXID_RE = re.compile(r"[0-9a-f]{64}")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")  # colour codes in cardano-cli output
WITNESS_RE = re.compile(r"8200825820[0-9a-f]{64}5840[0-9a-f]{128}")
UTXO_RE = re.compile(r"[0-9a-f]{64}#[0-9]{1,4}")

KINDS = {
    "register": {"unsigned": "register.unsigned", "signed": "register.signed", "witness": "cold-stake.witness",
                 "build": "build-register.sh", "submit": "assemble-submit.sh", "hash": "register-signed-tx.hash"},
    "deregister": {"unsigned": "deregister.unsigned", "signed": "deregister.signed",
                   "witness": "cold-stake-deregister.witness", "build": "build-deregister.sh",
                   "submit": "assemble-submit.sh", "hash": "deregister-signed-tx.hash"},
    "selfsend": {"unsigned": "move-cnight.unsigned", "signed": "move-cnight.signed", "witness": "cold-payment.witness",
                 "build": "build-move-cnight.sh", "submit": "submit-move-cnight.sh", "hash": "move-cnight-tx.hash"},
}


class Refuse(Exception):
    """A request we will not carry out; the message is shown on the page."""


def check_datum(text):
    d = json.loads(text)
    h = d["fields"][0]["fields"][0]["bytes"]
    k = d["fields"][1]["bytes"]
    ok = (d.get("constructor") == 0 and len(d["fields"]) == 2 and d["fields"][0].get("constructor") == 0
          and len(d["fields"][0]["fields"]) == 1 and re.fullmatch(r"[0-9a-f]{56}", h or "")
          and re.fullmatch(r"(?:[0-9a-f]{2}){1,33}", k or ""))
    if not ok:
        raise Refuse("This is not a registration datum (stake key hash + Dust public key).")
    return json.dumps({"constructor": 0, "fields": [{"constructor": 0, "fields": [{"bytes": h}]}, {"bytes": k}]},
                      indent=2) + "\n"


def check_witness(text):
    w = json.loads(text)
    if w.get("type") != "TxWitness ConwayEra" or not WITNESS_RE.fullmatch(w.get("cborHex", "")):
        raise Refuse("This is not a single key witness from the cold page.")
    return json.dumps({"type": "TxWitness ConwayEra", "description": "Key Witness ShelleyEra",
                       "cborHex": w["cborHex"]}, indent=4) + "\n"


class Hot:
    def __init__(self, args):
        self.dir = os.path.abspath(args.dir)
        self.network = args.network
        self.socket = args.socket
        self.cli = args.cli
        self.netflag = ["--mainnet"] if args.network == "mainnet" else ["--testnet-magic", "1"]
        self.validator = os.path.abspath(args.validator or os.path.join(REPO, "mapping_validator.plutus"))
        self.gift = False  # whether the last self-send build used a sponsor gift input
        self.env = dict(os.environ, CARDANO_CLI=self.cli, SOCKET_PATH=self.socket,
                        CARDANO_NODE_NETWORK_ID="mainnet" if args.network == "mainnet" else "1",
                        MAPPING_VALIDATOR=self.validator, QR_SEND="/nonexistent", QR_DECODE="/nonexistent")
        self.env.pop("ASSEMBLE_ONLY", None)
        self.validator_hash = self.cli_out(["hash", "script", "--script-file", self.validator]).strip()
        if args.network == "mainnet" and self.validator_hash != MAINNET_VALIDATOR:
            sys.exit(f"{self.validator} hashes to {self.validator_hash}, not the mainnet validator. Stopping.")
        self.validator_addr = self.cli_out(["address", "build", "--payment-script-file", self.validator]
                                           + self.netflag).strip()

    def path(self, name):
        return os.path.join(self.dir, name)

    def cli_out(self, argv, timeout=120):
        r = subprocess.run([self.cli] + argv, capture_output=True, text=True, timeout=timeout, env=self.env)
        if r.returncode != 0:
            msg = (r.stderr or r.stdout).strip()
            raise Refuse(msg.splitlines()[0] if msg else "cardano-cli failed")
        return r.stdout

    def script(self, name, args, stdin="", extra_env=None, timeout=600):
        env = dict(self.env, **(extra_env or {}))
        r = subprocess.run(["bash", os.path.join(HERE, name)] + args, cwd=self.dir, input=stdin, capture_output=True,
                           text=True, timeout=timeout, env=env)
        return r.returncode, ANSI_RE.sub("", r.stdout + r.stderr).strip()

    def txid(self, name):
        if not os.path.exists(self.path(name)):
            return None
        out = self.cli_out(["conway", "transaction", "txid", "--tx-file", self.path(name), "--output-text"]).strip()
        return out if TXID_RE.fullmatch(out) else None

    def read(self, name, limit=200000):
        p = self.path(name)
        if not os.path.exists(p):
            return None
        with open(p, encoding="utf-8") as f:
            return f.read(limit)

    def query_utxo(self, argv):
        return json.loads(self.cli_out(["conway", "query", "utxo", "--socket-path", self.socket, "--output-json"]
                                       + self.netflag + argv, timeout=300))

    # ------------------------------------------------------------------ API

    def state(self, _body):
        tip = None
        try:
            t = json.loads(self.cli_out(["conway", "query", "tip", "--socket-path", self.socket] + self.netflag))
            tip = {k: t.get(k) for k in ("slot", "epoch", "syncProgress", "block")}
        except Refuse as e:
            tip = {"error": str(e)}
        sponsor = None
        addr = (self.read("payment.addr") or "").strip()
        if addr:
            sponsor = {"address": addr}
            try:
                u = self.query_utxo(["--address", addr])
                ada_only = sorted((v["value"]["lovelace"] for v in u.values()
                                   if set(v["value"]) == {"lovelace"} and not v.get("inlineDatum") and not v.get("datumhash")),
                                  reverse=True)
                sponsor.update(utxos=len(u), lovelace=sum(v["value"]["lovelace"] for v in u.values()), adaOnly=ada_only)
            except Refuse as e:
                sponsor["error"] = str(e)
        files = {n: os.path.exists(self.path(n)) for n in
                 ("payment.addr", "payment.skey", "datum.json", "cold.addr") + tuple(
                     f for k in KINDS.values() for f in (k["unsigned"], k["witness"], k["signed"]))}
        return {"network": self.network, "dir": self.dir, "tip": tip, "sponsor": sponsor, "files": files,
                "validatorHash": self.validator_hash, "validatorAddress": self.validator_addr,
                "cnightPolicy": CNIGHT[self.network], "datum": self.read("datum.json"),
                "coldAddr": (self.read("cold.addr") or "").strip() or None}

    def put(self, body):
        name, text = body.get("name"), body.get("text")
        if not isinstance(text, str) or len(text) > 20000:
            raise Refuse("Missing or oversized content.")
        try:
            if name == "datum.json":
                out = check_datum(text)
            elif name in ("cold-stake.witness", "cold-stake-deregister.witness", "cold-payment.witness"):
                out = check_witness(text)
            elif name == "cold.addr":
                a = text.strip()
                want = "addr1" if self.network == "mainnet" else "addr_test1"
                if not re.fullmatch(r"(addr1|addr_test1)[02-9ac-hj-np-z]{50,110}", a) or not a.startswith(want):
                    raise Refuse(f"This is not a {self.network} address.")
                info = json.loads(self.cli_out(["address", "info", "--address", a]))
                b = info.get("base16", "")
                if len(b) != 114 or b[0] != "0":
                    raise Refuse("The address is not a base address (payment key + stake key).")
                out = a + "\n"
            else:
                raise Refuse("Unknown file.")
        except (ValueError, KeyError, TypeError, IndexError, AttributeError):
            raise Refuse(f"Could not read this as {name}.")
        with open(self.path(name), "w", encoding="utf-8") as f:
            f.write(out)
        return {"saved": name, "text": out}

    def registered(self, body):
        stake = body.get("stakeKeyHash", "")
        if not re.fullmatch(r"[0-9a-f]{56}", stake):
            raise Refuse("Bad stake key hash.")
        u = self.query_utxo(["--address", self.validator_addr])
        hits = []
        for ref, v in u.items():
            try:
                d = v["inlineDatum"]
                if d["fields"][0]["fields"][0]["bytes"] == stake and v["value"].get(self.validator_hash) == {"": 1}:
                    hits.append({"utxo": ref, "dustPublicKey": d["fields"][1]["bytes"],
                                 "lovelace": v["value"]["lovelace"]})
            except (KeyError, IndexError, TypeError):
                continue
        return {"total": len(u), "hits": hits}

    def build(self, body):
        kind = body.get("kind")
        k = KINDS.get(kind) or self._refuse("Unknown transaction kind.")
        need = ["cold.addr"] if kind == "selfsend" else ["payment.addr", "datum.json"]
        utxo = body.get("utxo") or ""
        if kind == "deregister" and utxo and not UTXO_RE.fullmatch(utxo):
            raise Refuse("Bad registration UTxO.")
        if kind == "selfsend" and body.get("gift"):
            need.append("payment.addr")
        for n in need:
            if not os.path.exists(self.path(n)):
                raise Refuse(f"{n} is missing in {self.dir}.")
        for n in (k["unsigned"], k["witness"], k["signed"]):  # a new build makes the old witness useless
            if os.path.exists(self.path(n)):
                os.replace(self.path(n), self.path(n + ".old"))
        if kind == "register":
            rc, log = self.script(k["build"], ["datum.json", "payment.addr"])
        elif kind == "deregister":
            rc, log = self.script(k["build"], ["datum.json", "payment.addr", utxo])
        else:
            self.gift = bool(body.get("gift"))
            rc, log = self.script(k["build"], ["cold.addr"] + (["payment.addr"] if self.gift else []))
        if rc != 0:
            return {"ok": False, "log": log}
        return {"ok": True, "log": log, "unsigned": self.read(k["unsigned"]), "txid": self.txid(k["unsigned"])}

    def _submit_args(self, kind):
        k = KINDS[kind]
        if kind in ("register", "deregister"):
            return [k["witness"], "payment.skey", "datum.json", k["unsigned"]]
        return [k["witness"], "cold.addr", "payment.skey" if self.gift else "", k["unsigned"]]

    def assemble(self, body):
        kind = body.get("kind")
        k = KINDS.get(kind) or self._refuse("Unknown transaction kind.")
        for n in (k["unsigned"], k["witness"]):
            if not os.path.exists(self.path(n)):
                raise Refuse(f"{n} is missing; build the transaction and receive the witness first.")
        rc, log = self.script(k["submit"], self._submit_args(kind), extra_env={"ASSEMBLE_ONLY": "1"})
        if rc != 0:
            return {"ok": False, "log": log}
        return {"ok": True, "log": log, "txid": self.txid(k["signed"]), "unsignedTxid": self.txid(k["unsigned"])}

    def submit(self, body):
        kind = body.get("kind")
        k = KINDS.get(kind) or self._refuse("Unknown transaction kind.")
        if body.get("confirm") != "SUBMIT":
            raise Refuse("Type SUBMIT to confirm.")
        want = body.get("txid", "")
        have = self.txid(k["signed"])
        if not have or have != want:
            raise Refuse("The signed transaction on disk is not the one shown on the page. Assemble again.")
        rc, log = self.script(k["submit"], self._submit_args(kind), stdin="SUBMIT\n")
        return {"ok": rc == 0, "log": log, "txid": have}

    def landed(self, body):
        txid = body.get("txid", "")
        if not TXID_RE.fullmatch(txid):
            raise Refuse("Bad transaction id.")
        u = self.query_utxo(["--tx-in", f"{txid}#0"])
        return {"landed": bool(u), "outputs": u}

    @staticmethod
    def _refuse(msg):
        raise Refuse(msg)


def make_handler(hot, token, port):
    origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    routes = {"state": hot.state, "put": hot.put, "registered": hot.registered, "build": hot.build,
              "assemble": hot.assemble, "submit": hot.submit, "landed": hot.landed}
    page_csp = ("default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; "
                "img-src data: blob:; media-src blob: mediastream:; connect-src 'self'; form-action 'none'; "
                "base-uri 'none'; frame-ancestors 'none'")

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "hot-server"
        sys_version = ""

        def log_message(self, fmt, *a):  # keep the terminal quiet; paths carry no secrets, but tokens could
            pass

        def send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            if ctype.startswith("text/html"):
                self.send_header("Content-Security-Policy", page_csp)
            self.end_headers()
            self.wfile.write(data)

        def host_ok(self):
            return self.headers.get("Host") in hosts

        def do_GET(self):
            if not self.host_ok():
                return self.send(403, {"error": "wrong host"})
            if urllib.parse.urlsplit(self.path).path != "/":
                return self.send(404, {"error": "not found"})
            with open(PAGE, "rb") as f:
                self.send(200, f.read(), "text/html; charset=utf-8")

        def do_POST(self):
            if not self.host_ok() or self.headers.get("Origin") not in origins:
                return self.send(403, {"error": "This server only answers its own page."})
            if not secrets.compare_digest(self.headers.get("X-Hot-Token", ""), token):
                return self.send(403, {"error": "Missing or wrong token: open the URL the server printed."})
            path = urllib.parse.urlsplit(self.path).path
            fn = routes.get(path.removeprefix("/api/")) if path.startswith("/api/") else None
            if not fn:
                return self.send(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", "0"))
                if n > 64000:
                    raise Refuse("Request too large.")
                body = json.loads(self.rfile.read(n) or b"{}")
                if not isinstance(body, dict):
                    raise Refuse("Bad request.")
                self.send(200, fn(body))
            except Refuse as e:
                self.send(400, {"error": str(e)})
            except subprocess.TimeoutExpired:
                self.send(500, {"error": "A command took too long and was stopped."})
            except Exception as e:  # shown on the page; never contains key material (we never read it)
                self.send(500, {"error": f"{type(e).__name__}: {e}"})

    return Handler


def main():
    ap = argparse.ArgumentParser(description="Local web page for the hot side.")
    ap.add_argument("--dir", required=True, help="folder with payment.addr and payment.skey; files are written here")
    ap.add_argument("--socket", required=True, help="cardano-node socket")
    ap.add_argument("--network", choices=["mainnet", "preprod"], default="mainnet")
    ap.add_argument("--validator", help="mapping validator .plutus (default: mapping_validator.plutus, mainnet)")
    ap.add_argument("--cli", default=os.environ.get("CARDANO_CLI", "cardano-cli"), help="path to cardano-cli")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    if not os.path.isdir(args.dir):
        sys.exit(f"{args.dir} is not a folder.")
    if args.network == "preprod" and not args.validator:
        sys.exit("--network preprod needs --validator <preprod mapping validator .plutus>.")
    if not os.path.exists(PAGE):
        sys.exit(f"{PAGE} is missing; build it with cold-page/build.sh.")
    hot = Hot(args)
    token = secrets.token_hex(16)
    srv = http.server.HTTPServer(("127.0.0.1", args.port), make_handler(hot, token, args.port))
    with open(PAGE, "rb") as f:
        page_hash = hashlib.sha256(f.read()).hexdigest()
    print(f"Network:   {args.network}")
    print(f"Folder:    {hot.dir}")
    print(f"Validator: {hot.validator_addr} ({hot.validator_hash})")
    print(f"Page:      hot/hot-page.html sha256 {page_hash}")
    print(f"Open:      http://127.0.0.1:{args.port}/#{token}")
    print("Press Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()

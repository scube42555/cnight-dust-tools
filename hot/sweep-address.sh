#!/usr/bin/env bash
# HOT (online) machine. Empties one address: every UTxO at it (all its ADA and every token) goes to another address in
# one transaction, less the fee. Nothing is left behind at the source address.
#
#   hot/sweep-address.sh <from-payment.addr> <payment.skey> <destination address, or a file holding it>
#
# from .addr   the address to empty, signed for with payment.skey (for example the sponsor's mainnet/payment.addr).
#              It must be the address of that key: the script checks the key hash.
# destination  where everything goes. It must be on the same network and must not be a script address (funds sent to
#              a script address without the right datum can be lost for good); set ALLOW_SCRIPT_DEST=1 to override.
#
# What a sweep does NOT move:
#   - staking rewards and the 2 ADA stake key deposit: they sit in the stake account, not in UTxOs. Withdraw them
#     (and deregister the stake key) from the wallet that holds the stake key.
#   - other addresses of the same wallet: only this one address (one payment key) is emptied.
#   - a DUST registration: it lives at the mapping validator, not here (deregister it with the hot page).
# Moving cNIGHT away from an address stops DUST generation for it, unless the destination's stake key is registered.
#
# The cold wallet's address cannot be swept with this: its payment key is on the cold machine only, and the cold page
# signs nothing that sends cNIGHT elsewhere.
#
# The transaction is shown, then signed with payment.skey and submitted only after you type the last 8 characters of
# the destination and then SUBMIT. Writes sweep.unsigned, sweep.signed and sweep-tx.hash.
#
# Requirements: cardano-cli and a synced cardano-node reachable through its node.socket. Set these before running:
#   CARDANO_CLI              path to cardano-cli, if it is not on your PATH (checked against cardano-cli 11.2.3)
#   SOCKET_PATH              the node's socket (default /ada/mainnet/db/node.socket)
#   CARDANO_NODE_NETWORK_ID  mainnet (the default), or 1 for preprod
#   TTL_SLOTS                validity window in slots (default 7200); ALLOW_SCRIPT_DEST=1 allows a script destination
#
# If the node runs on another machine, forward its socket to a local path over SSH first, in a separate terminal
# (it stays open until Ctrl-C; the remote user must be able to read and write the socket):
#
#   ssh -nNT -o StreamLocalBindUnlink=yes -L /tmp/mainnet.socket:/ada/mainnet/db/node.socket user@node-host
#
# then run, for example:
#
#   CARDANO_CLI=/path/to/cardano-cli SOCKET_PATH=/tmp/mainnet.socket \
#     hot/sweep-address.sh payment.addr payment.skey <destination>
set -euo pipefail

CLI="${CARDANO_CLI:-cardano-cli}"
# cardano-cli 11 prints txid as JSON unless asked for text; older versions print text and lack the flag.
txid() { "$CLI" conway transaction txid --tx-file "$1" --output-text 2>/dev/null || "$CLI" conway transaction txid --tx-file "$1"; }
ada() { python3 -I -c 'import sys; print(f"{int(sys.argv[1]) / 1e6:.6f}")' "$1"; }

export CARDANO_NODE_NETWORK_ID="${CARDANO_NODE_NETWORK_ID:-mainnet}"
SOCKET_PATH="${SOCKET_PATH:-/ada/mainnet/db/node.socket}"

USAGE="usage: hot/sweep-address.sh <from-payment.addr> <payment.skey> <destination address or file>"
FROM="$(tr -d '[:space:]' < "${1:?$USAGE}")"
SKEY="${2:?$USAGE}"
DEST_ARG="${3:?$USAGE}"
if [[ -f "$DEST_ARG" ]]; then DEST="$(tr -d '[:space:]' < "$DEST_ARG")"; else DEST="$(tr -d '[:space:]' <<< "$DEST_ARG")"; fi

if [[ ! -S "$SOCKET_PATH" ]]; then
  echo "No node socket at $SOCKET_PATH. Set SOCKET_PATH, or forward a remote node's socket first:" >&2
  echo "  ssh -nNT -o StreamLocalBindUnlink=yes -L /tmp/mainnet.socket:/ada/mainnet/db/node.socket user@node-host" >&2
  exit 1
fi
command -v "$CLI" > /dev/null || { echo "cardano-cli not found ($CLI). Set CARDANO_CLI to its path." >&2; exit 1; }

echo "Network: $CARDANO_NODE_NETWORK_ID"

# Both addresses: right network; the source belongs to this key; the destination is not a script (unless allowed).
"$CLI" address info --address "$FROM" > sweep-from-info.json
"$CLI" address info --address "$DEST" > sweep-dest-info.json || { echo "The destination is not a Cardano address. Stopping." >&2; exit 1; }
VKEY_HASH="$("$CLI" conway key verification-key --signing-key-file "$SKEY" --verification-key-file /dev/stdout \
  | "$CLI" address key-hash --payment-verification-key-file /dev/stdin)"
python3 -I - sweep-from-info.json sweep-dest-info.json "$CARDANO_NODE_NETWORK_ID" "$VKEY_HASH" "${ALLOW_SCRIPT_DEST:-}" <<'EOF'
import json, sys
src, dst = (json.load(open(p))["base16"] for p in sys.argv[1:3])
net, key, allow = ("1" if sys.argv[3] == "mainnet" else "0"), sys.argv[4], sys.argv[5]
if src[0] not in "0246" or src[1] != net or src[2:58] != key:
    sys.exit("The source address is not this payment key's address on this network.")
if dst[0] == "8":
    sys.exit("The destination is a Byron address. Stopping.")
if dst[1] != net:
    sys.exit("The destination is on another network. Stopping.")
if dst[0] in "1357" and not allow:
    sys.exit("The destination is a script address: funds sent there without the right datum can be lost for good. "
             "Set ALLOW_SCRIPT_DEST=1 if you are sure.")
if src == dst:
    sys.exit("The destination is the source address itself.")
EOF

"$CLI" conway query utxo --address "$FROM" --socket-path "$SOCKET_PATH" --output-json > sweep-utxos.json
# Line 1: total lovelace. Line 2: the tokens, one description. Then one UTxO per line.
PLAN="$(python3 -I - sweep-utxos.json <<'EOF'
import json, sys
u = json.load(open(sys.argv[1]))
if not u:
    sys.exit("The source address holds nothing; it is already empty.")
tokens = {}
for k, v in sorted(u.items()):
    val = v["value"]
    extra = [f"{sum(a.values())} of {p[:8]}…" for p, a in val.items() if p != "lovelace"]
    print(f"  {k}  {val['lovelace'] / 1e6:.6f} ADA" + ("  + " + ", ".join(extra) if extra else ""), file=sys.stderr)
    for p, assets in val.items():
        if p != "lovelace":
            for name, n in assets.items():
                tokens[(p, name)] = tokens.get((p, name), 0) + n
print(sum(v["value"]["lovelace"] for v in u.values()))
print(", ".join(f"{n} of {p}" + (f".{name}" if name else "") for (p, name), n in sorted(tokens.items())))
print("\n".join(sorted(u)))
EOF
)"
mapfile -t P <<< "$PLAN"
TOTAL="${P[0]}"
TOKENS="${P[1]}"
TX_IN=()
for i in "${P[@]:2}"; do TX_IN+=(--tx-in "$i"); done

TTL_SLOTS="${TTL_SLOTS:-7200}"
TIP_SLOT="$("$CLI" conway query tip --socket-path "$SOCKET_PATH" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["slot"])')"

rm -f sweep.unsigned sweep.signed
# No --tx-out: the change output, to the destination, carries everything.
"$CLI" conway transaction build \
  "${TX_IN[@]}" \
  --change-address "$DEST" \
  --invalid-hereafter $((TIP_SLOT + TTL_SLOTS)) \
  --witness-override 1 \
  --socket-path "$SOCKET_PATH" \
  --out-file sweep.unsigned

# Check what was built: one output, to the destination, and the fee read back from the body.
"$CLI" debug transaction view --tx-file sweep.unsigned > sweep-view.json
FEE="$(python3 -I - sweep-view.json "$DEST" "$TOTAL" sweep-utxos.json <<'EOF'
import json, re, sys
t, dest, total = json.load(open(sys.argv[1])), sys.argv[2], int(sys.argv[3])
outs = t["outputs"]
fee = int(re.sub(r"\D", "", str(t["fee"])))
if len(outs) != 1 or outs[0]["address"] != dest:
    sys.exit("The built transaction does not have exactly one output, to the destination. Stopping.")
if outs[0]["amount"]["lovelace"] + fee != total:
    sys.exit("The built transaction does not move all the ADA. Stopping.")
# Every token unit, per policy, must be in the output.
have, want = {}, {}
for k, v in outs[0]["amount"].items():
    if k.startswith("policy "):
        have[k.split()[1]] = sum(v.values())
for v in json.load(open(sys.argv[4])).values():
    for p, assets in v["value"].items():
        if p != "lovelace":
            want[p] = want.get(p, 0) + sum(assets.values())
if have != want:
    sys.exit("The built transaction does not move every token. Stopping.")
if fee > 2_000_000:
    sys.exit(f"The fee is {fee / 1e6} ADA, which is too high. Stopping.")
print(fee)
EOF
)"
echo
echo "Sweep of $(( ${#TX_IN[@]} / 2 )) UTxO(s), everything at"
echo "  $FROM"
echo "to"
echo "  $DEST"
echo "ADA:      $(ada "$TOTAL") in all; fee $(ada "$FEE"); the destination receives $(ada $((TOTAL - FEE)))"
[[ -n "$TOKENS" ]] && echo "Tokens:   all of them go too: $TOKENS"
echo "Afterwards the source address holds nothing. Rewards and the stake key deposit are not touched."

"$CLI" conway transaction sign --tx-body-file sweep.unsigned --signing-key-file "$SKEY" --out-file sweep.signed
TXID="$(txid sweep.signed)"
echo "Signed transaction: sweep.signed (tx id $TXID)"
read -r -p "Type the last 8 characters of the destination address to confirm it: " tail8
if [[ "$tail8" != "${DEST: -8}" ]]; then
  echo "That does not match the destination. Not submitted."
  exit 1
fi
read -r -p "Type SUBMIT to send everything to it on the $CARDANO_NODE_NETWORK_ID network: " answer
if [[ "$answer" != SUBMIT ]]; then
  echo "Not submitted."
  exit 1
fi
"$CLI" conway transaction submit --socket-path "$SOCKET_PATH" --tx-file sweep.signed
echo "$TXID" > sweep-tx.hash
echo "Submitted $TXID. Once it is on chain (about a minute) the source address is empty."

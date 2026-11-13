#!/usr/bin/env bash
# HOT (online) machine. Joins the cold payment-key witness to the cNIGHT self-send, adds the sponsor's signature if a
# sponsor UTxO is an input, and submits.
#
#   hot/submit-move-cnight.sh <cold-payment.witness | received-witness-*.mqr> <cold.addr> [sponsor-payment.skey] [move-cnight.unsigned]
#
# Pass the sponsor key when hot/build-move-cnight.sh was given a sponsor address.
#
# ASSEMBLE_ONLY=1 stops after assembling, with exit status 0 (used by hot/hot-server.py, which asks for SUBMIT itself).
# Environment: CARDANO_CLI, CARDANO_NODE_NETWORK_ID (mainnet, or 1 for preprod), SOCKET_PATH, QR_DECODE (path to qr-decode.js).
set -euo pipefail

CLI="${CARDANO_CLI:-cardano-cli}"
txid() { "$CLI" conway transaction txid --tx-file "$1" --output-text 2>/dev/null || "$CLI" conway transaction txid --tx-file "$1"; }

export CARDANO_NODE_NETWORK_ID="${CARDANO_NODE_NETWORK_ID:-mainnet}"
SOCKET_PATH="${SOCKET_PATH:-/ada/mainnet/db/node.socket}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
QR_DECODE="${QR_DECODE:-$HERE/../midnight-cold-hot/dist/qr-decode.js}"

USAGE="usage: hot/submit-move-cnight.sh <cold-payment.witness|.mqr> <cold.addr> [sponsor-payment.skey] [move-cnight.unsigned]"
COLD="${1:?$USAGE}"
COLD_ADDR="$(tr -d '[:space:]' < "${2:?$USAGE}")"
SPONSOR_SKEY="${3:-}"
TX="${4:-move-cnight.unsigned}"

echo "Network: $CARDANO_NODE_NETWORK_ID"

if [[ "$COLD" == *.mqr ]]; then
  node "$QR_DECODE" "$COLD" cold-payment.witness
  COLD=cold-payment.witness
fi

# The witness crossed the air gap: check its shape, and that its key is the payment key of the cold address.
"$CLI" address info --address "$COLD_ADDR" > cold-addr-info.json
python3 -I - "$COLD" cold-addr-info.json <<'EOF'
import hashlib, json, re, sys
w = json.load(open(sys.argv[1]))
h = w.get("cborHex", "")
if w.get("type") != "TxWitness ConwayEra" or not re.fullmatch(r"8200825820[0-9a-f]{64}5840[0-9a-f]{128}", h):
    sys.exit("The cold witness is not a single key witness from the cold page.")
vkey_hash = hashlib.blake2b(bytes.fromhex(h[10:74]), digest_size=28).hexdigest()
b = json.load(open(sys.argv[2])).get("base16", "")
if len(b) != 114 or b[0] != "0":
    sys.exit("cold.addr is not a base address (payment key + stake key).")
if vkey_hash != b[2:58]:
    sys.exit(f"The cold witness is signed by key {vkey_hash}, but cold.addr has payment key {b[2:58]}.")
print(f"Cold witness: payment key {vkey_hash} (matches cold.addr)")
EOF

WITNESS_FILES=(--witness-file "$COLD")
if [[ -n "$SPONSOR_SKEY" ]]; then
  "$CLI" conway transaction witness --tx-body-file "$TX" --signing-key-file "$SPONSOR_SKEY" --out-file sponsor-move.witness
  WITNESS_FILES+=(--witness-file sponsor-move.witness)
fi
"$CLI" conway transaction assemble --tx-body-file "$TX" "${WITNESS_FILES[@]}" --out-file move-cnight.signed

TXID="$(txid move-cnight.signed)"
echo "Signed transaction: move-cnight.signed (tx id $TXID)"
if [[ -n "${ASSEMBLE_ONLY:-}" ]]; then
  echo "Assembled only (ASSEMBLE_ONLY is set); not submitted."
  exit 0
fi
read -r -p "Type SUBMIT to send it to the $CARDANO_NODE_NETWORK_ID network: " answer
if [[ "$answer" != SUBMIT ]]; then
  echo "Not submitted."
  exit 1
fi
"$CLI" conway transaction submit --socket-path "$SOCKET_PATH" --tx-file move-cnight.signed
echo "$TXID" > move-cnight-tx.hash
echo "Submitted $TXID. DUST should start to appear at your Midnight Dust address about 12 hours after it is on chain."

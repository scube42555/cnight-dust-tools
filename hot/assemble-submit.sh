#!/usr/bin/env bash
# HOT (online) machine. Adds the sponsor's signature to the registration, joins the cold stake-key witness, and submits.
#
#   hot/assemble-submit.sh <cold-stake.witness | received-witness-*.mqr> <sponsor-payment.skey> [datum.json] [register.unsigned]
#
# The cold witness comes from dust-register-cold.html step 5, as a file or as QR frames received with
# midnight-cold-hot's receiver.html / qr_scan.py (an .mqr file, decoded here with qr-decode.js).
#
# ASSEMBLE_ONLY=1 stops after assembling, with exit status 0 (used by hot/hot-server.py, which asks for SUBMIT itself).
# Environment: CARDANO_CLI (path to cardano-cli), CARDANO_NODE_NETWORK_ID (mainnet, or 1 for preprod), SOCKET_PATH, QR_DECODE (path to qr-decode.js).
# Run against a preprod node (12 Nov 2026) with cardano-cli 11.2.3.
set -euo pipefail

CLI="${CARDANO_CLI:-cardano-cli}"
# cardano-cli 11 prints txid as JSON unless asked for text; older versions print text and lack the flag.
txid() { "$CLI" conway transaction txid --tx-file "$1" --output-text 2>/dev/null || "$CLI" conway transaction txid --tx-file "$1"; }

export CARDANO_NODE_NETWORK_ID="${CARDANO_NODE_NETWORK_ID:-mainnet}"
SOCKET_PATH="${SOCKET_PATH:-/ada/mainnet/db/node.socket}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
QR_DECODE="${QR_DECODE:-$HERE/../midnight-cold-hot/dist/qr-decode.js}"

COLD="${1:?usage: hot/assemble-submit.sh <cold-stake.witness|.mqr> <sponsor-payment.skey> [datum.json] [register.unsigned]}"
SPONSOR_SKEY="${2:?usage: hot/assemble-submit.sh <cold-stake.witness|.mqr> <sponsor-payment.skey> [datum.json] [register.unsigned]}"
DATUM="${3:-datum.json}"
TX="${4:-register.unsigned}"

echo "Network: $CARDANO_NODE_NETWORK_ID"

if [[ "$COLD" == *.mqr ]]; then
  node "$QR_DECODE" "$COLD" cold-stake.witness
  COLD=cold-stake.witness
fi

# The witness crossed the air gap: check its shape, and that its key is the stake key named in the datum.
python3 -I - "$COLD" "$DATUM" <<'EOF'
import hashlib, json, re, sys
w = json.load(open(sys.argv[1]))
h = w.get("cborHex", "")
if w.get("type") != "TxWitness ConwayEra" or not re.fullmatch(r"8200825820[0-9a-f]{64}5840[0-9a-f]{128}", h):
    sys.exit("The cold witness is not a single key witness from the cold page.")
vkey_hash = hashlib.blake2b(bytes.fromhex(h[10:74]), digest_size=28).hexdigest()
want = json.load(open(sys.argv[2]))["fields"][0]["fields"][0]["bytes"]
if vkey_hash != want:
    sys.exit(f"The cold witness is signed by key {vkey_hash}, but the datum names stake key {want}.")
print(f"Cold witness: stake key {vkey_hash} (matches the datum)")
EOF

"$CLI" conway transaction witness --tx-body-file "$TX" --signing-key-file "$SPONSOR_SKEY" --out-file sponsor.witness
"$CLI" conway transaction assemble --tx-body-file "$TX" --witness-file "$COLD" --witness-file sponsor.witness --out-file register.signed

TXID="$(txid register.signed)"
echo "Signed transaction: register.signed (tx id $TXID)"
if [[ -n "${ASSEMBLE_ONLY:-}" ]]; then
  echo "Assembled only (ASSEMBLE_ONLY is set); not submitted."
  exit 0
fi
read -r -p "Type SUBMIT to send it to the $CARDANO_NODE_NETWORK_ID network: " answer
if [[ "$answer" != SUBMIT ]]; then
  echo "Not submitted."
  exit 1
fi
"$CLI" conway transaction submit --socket-path "$SOCKET_PATH" --tx-file register.signed
echo "$TXID" > register-signed-tx.hash
echo "Submitted $TXID. Once it is on chain, move the cNIGHT (README step 7) to start DUST generation."

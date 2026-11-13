#!/usr/bin/env bash
# HOT (online) machine. Builds the unsigned cNIGHT self-send that starts DUST generation once the registration is
# on chain: the cold wallet's cNIGHT UTxOs are spent and everything comes back to the same address.
# Optional: sending cNIGHT to the cold address from another wallet starts generation too, with nothing to sign offline.
#
#   hot/build-move-cnight.sh <cold.addr> [sponsor-payment.addr]
#
# cold.addr     the cold address from dust-register-cold.html step 2 (base address: payment key + registered stake key).
# sponsor .addr optional. Without it the cold wallet pays the fee (about 0.2 ADA) out of the ADA on its cNIGHT UTxOs.
#               With it, one small ADA-only sponsor UTxO is added as an input. Its whole value goes to the cold wallet
#               (the cold page signs only if every output goes back to the cold address), so it is a gift that covers
#               the fee. The smallest ADA-only UTxO of at least 1 ADA is used, up to GIFT_MAX_ADA (default 5).
#
# Writes move-cnight.unsigned and, if midnight-cold-hot is next to this repository, move-cnight-send.html.
# The cold machine signs with the payment key; hot/submit-move-cnight.sh finishes the job.
#
# Environment: CARDANO_CLI, CARDANO_NODE_NETWORK_ID (mainnet, or 1 for preprod), SOCKET_PATH, TTL_SLOTS (default 7200),
#   CNIGHT_POLICY (default: the mainnet or preprod cNIGHT policy), SPONSOR_UTXO (use this sponsor UTxO, no size limit),
#   GIFT_MAX_ADA, QR_SEND (path to qr-send.js).
set -euo pipefail

CLI="${CARDANO_CLI:-cardano-cli}"
txid() { "$CLI" conway transaction txid --tx-file "$1" --output-text 2>/dev/null || "$CLI" conway transaction txid --tx-file "$1"; }

export CARDANO_NODE_NETWORK_ID="${CARDANO_NODE_NETWORK_ID:-mainnet}"
SOCKET_PATH="${SOCKET_PATH:-/ada/mainnet/db/node.socket}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
QR_SEND="${QR_SEND:-$HERE/../midnight-cold-hot/dist/qr-send.js}"
if [[ "$CARDANO_NODE_NETWORK_ID" == mainnet ]]; then
  # The mainnet mapping validator names this policy in its own script bytes.
  CNIGHT_POLICY="${CNIGHT_POLICY:-0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa}"
else
  CNIGHT_POLICY="${CNIGHT_POLICY:-d2dbff622e509dda256fedbd31ef6e9fd98ed49ad91d5c0e07f68af1}"
fi
GIFT_MAX_ADA="${GIFT_MAX_ADA:-5}"

USAGE="usage: hot/build-move-cnight.sh <cold.addr> [sponsor-payment.addr]"
COLD_ADDR="$(tr -d '[:space:]' < "${1:?$USAGE}")"
SPONSOR_ADDR=""
[[ -n "${2:-}" ]] && SPONSOR_ADDR="$(tr -d '[:space:]' < "$2")"

echo "Network:      $CARDANO_NODE_NETWORK_ID"
echo "cNIGHT policy: $CNIGHT_POLICY"

# The address crossed the air gap: it must be a base address (key payment + key stake) on this network.
"$CLI" address info --address "$COLD_ADDR" > cold-addr-info.json
python3 -I - cold-addr-info.json "$CARDANO_NODE_NETWORK_ID" <<'EOF'
import json, sys
i = json.load(open(sys.argv[1]))
b = i.get("base16", "")
want_net = "1" if sys.argv[2] == "mainnet" else "0"
if len(b) != 114 or b[0] != "0" or b[1] != want_net:
    sys.exit("cold.addr is not a base address (payment key + stake key) on this network.")
print(f"Cold address: payment key {b[2:58]}, stake key {b[58:]}")
EOF

"$CLI" conway query utxo --address "$COLD_ADDR" --socket-path "$SOCKET_PATH" --output-json > cold-utxos.json
# Command substitution, not < <(...): a failure inside process substitution would not stop the script.
PICKED="$(python3 -I - cold-utxos.json "$CNIGHT_POLICY" <<'EOF'
import json, sys
u, policy = json.load(open(sys.argv[1])), sys.argv[2]
picked = [k for k, v in sorted(u.items()) if policy in v["value"]]
if not picked:
    sys.exit("The cold address holds no cNIGHT of this policy. Check the address index on the cold page, or CNIGHT_POLICY.")
total = sum(sum(u[k]["value"][policy].values()) for k in picked)
print(f"{len(picked)} cNIGHT UTxO(s), {total} unit(s) in all", file=sys.stderr)
print("\n".join(picked))
EOF
)"
mapfile -t COLD_IN <<< "$PICKED"

TX_IN=()
for i in "${COLD_IN[@]}"; do TX_IN+=(--tx-in "$i"); done
WITNESSES=1

if [[ -n "$SPONSOR_ADDR" ]]; then
  if [[ -z "${SPONSOR_UTXO:-}" ]]; then
    "$CLI" conway query utxo --address "$SPONSOR_ADDR" --socket-path "$SOCKET_PATH" --output-json > sponsor-utxos.json
    SPONSOR_UTXO="$(python3 -I - sponsor-utxos.json "$GIFT_MAX_ADA" <<'EOF'
import json, sys
u, cap = json.load(open(sys.argv[1])), int(float(sys.argv[2]) * 1_000_000)
ada = sorted((v["value"]["lovelace"], k) for k, v in u.items()
             if set(v["value"]) == {"lovelace"} and not v.get("inlineDatum") and not v.get("datumhash")
             and not v.get("referenceScript") and v["value"]["lovelace"] >= 1_000_000)
if not ada:
    sys.exit("The sponsor has no ADA-only UTxO of at least 1 ADA.")
if ada[0][0] > cap:
    sys.exit(f"The sponsor's smallest ADA-only UTxO is {ada[0][0] / 1e6} ADA, more than GIFT_MAX_ADA={cap / 1e6}. "
             "Its whole value would go to the cold wallet. Send the sponsor a 2 ADA output first, or set SPONSOR_UTXO.")
print(ada[0][1])
EOF
)"
  fi
  echo "Sponsor gift: $SPONSOR_UTXO (its whole value goes to the cold wallet and pays the fee)"
  TX_IN+=(--tx-in "$SPONSOR_UTXO")
  WITNESSES=2
fi

TTL_SLOTS="${TTL_SLOTS:-7200}"
TIP_SLOT="$("$CLI" conway query tip --socket-path "$SOCKET_PATH" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["slot"])')"
EXPIRES=$((TIP_SLOT + TTL_SLOTS))
echo "Expires:      slot $EXPIRES (tip $TIP_SLOT + $TTL_SLOTS)"

rm -f move-cnight.unsigned
# No --tx-out: the change output, back to the cold address, carries everything (all tokens and the ADA minus the fee).
"$CLI" conway transaction build \
  "${TX_IN[@]}" \
  --change-address "$COLD_ADDR" \
  --invalid-hereafter "$EXPIRES" \
  --witness-override "$WITNESSES" \
  --socket-path "$SOCKET_PATH" \
  --out-file move-cnight.unsigned

echo "Wrote move-cnight.unsigned (tx id $(txid move-cnight.unsigned))"

if [[ -f "$QR_SEND" ]]; then
  node "$QR_SEND" tx move-cnight.unsigned --html move-cnight-send.html
  echo "Open move-cnight-send.html and scan it on the cold machine (or copy move-cnight.unsigned by USB)."
else
  echo "qr-send.js not found at $QR_SEND (set QR_SEND); copy move-cnight.unsigned to the cold machine by USB."
fi

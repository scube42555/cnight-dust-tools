#!/usr/bin/env bash
# HOT (online) machine. Builds the unsigned DUST registration for a cold wallet, paid for by a sponsor wallet.
#
#   hot/build-register.sh <datum.json> <sponsor-payment.addr> [UTXO] [COLLATERAL]
#
# datum.json   from the cold page (dust-register-cold.html, step 2): the cold stake key hash and Dust public key.
# sponsor .addr the sponsor's payment address file. Its UTxOs pay the ADA locked with the registration token (the
#              ledger minimum for that output, about 1.35 ADA, unless REG_LOVELACE is set), the fee and the collateral.
#              With no UTXO/COLLATERAL given, two ADA-only UTxOs are picked: the largest pays (at least 3 ADA) and the
#              smallest other one of at least 2 ADA is the collateral (it is only taken if the script fails).
#
# Writes register.unsigned and, if midnight-cold-hot is next to this repository, register-send.html (the QR codes
# for the cold page). The cold machine signs with the stake key only; hot/assemble-submit.sh finishes the job.
#
# Environment: CARDANO_CLI (path to cardano-cli), REG_LOVELACE (ADA locked in the registration output, in lovelace;
#   default: the minimum the ledger allows, from the node's protocol parameters), TTL_SLOTS (default 7200),
#   CARDANO_NODE_NETWORK_ID (mainnet, or 1 for preprod), SOCKET_PATH, QR_SEND (path to qr-send.js).
# Run against a preprod node (12 Nov 2026) with cardano-cli 11.2.3.
set -euo pipefail

CLI="${CARDANO_CLI:-cardano-cli}"
# cardano-cli 11 prints txid as JSON unless asked for text; older versions print text and lack the flag.
txid() { "$CLI" conway transaction txid --tx-file "$1" --output-text 2>/dev/null || "$CLI" conway transaction txid --tx-file "$1"; }

export CARDANO_NODE_NETWORK_ID="${CARDANO_NODE_NETWORK_ID:-mainnet}"
SOCKET_PATH="${SOCKET_PATH:-/ada/mainnet/db/node.socket}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
QR_SEND="${QR_SEND:-$HERE/../midnight-cold-hot/dist/qr-send.js}"
MAINNET_VALIDATOR=73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5

DATUM="${1:?usage: hot/build-register.sh <datum.json> <sponsor-payment.addr> [UTXO] [COLLATERAL]}"
SPONSOR_ADDR_FILE="${2:?usage: hot/build-register.sh <datum.json> <sponsor-payment.addr> [UTXO] [COLLATERAL]}"
UTXO="${3:-}"
COLLATERAL="${4:-}"
SCRIPT="${MAPPING_VALIDATOR:-$HERE/mapping_validator.plutus}"
REDEEMER="$HERE/register_red.json"
SPONSOR_ADDR="$(< "$SPONSOR_ADDR_FILE")"

echo "Network: $CARDANO_NODE_NETWORK_ID"

# The datum crossed the air gap: read only the two fields we need and check their shape.
STAKE_KEY_HASH="$(python3 -I - "$DATUM" <<'EOF'
import json, re, sys
d = json.load(open(sys.argv[1]))
h = d["fields"][0]["fields"][0]["bytes"]
k = d["fields"][1]["bytes"]
ok = (d["constructor"] == 0 and len(d["fields"]) == 2 and d["fields"][0]["constructor"] == 0
      and re.fullmatch(r"[0-9a-f]{56}", h) and re.fullmatch(r"[0-9a-f]{2,66}", k))
if not ok:
    sys.exit("datum.json is not a registration datum (stake key hash + Dust public key)")
print(h)
EOF
)"

VALIDATOR_HASH="$("$CLI" hash script --script-file "$SCRIPT")"
VALIDATOR_ADDR="$("$CLI" address build --payment-script-file "$SCRIPT")"
if [[ "$CARDANO_NODE_NETWORK_ID" == mainnet && "$VALIDATOR_HASH" != "$MAINNET_VALIDATOR" ]]; then
  echo "mapping_validator.plutus hashes to $VALIDATOR_HASH, not the mainnet validator $MAINNET_VALIDATOR. Stopping." >&2
  exit 1
fi

if [[ -z "$UTXO" || -z "$COLLATERAL" ]]; then
  "$CLI" conway query utxo --address "$SPONSOR_ADDR" --socket-path "$SOCKET_PATH" --output-json > sponsor-utxos.json
  read -r UTXO COLLATERAL < <(python3 -I - sponsor-utxos.json <<'EOF'
import json, sys
u = json.load(open(sys.argv[1]))
# ADA-only UTxOs (no tokens, no datum, no script)
ada = sorted(((v["value"]["lovelace"], k) for k, v in u.items()
              if set(v["value"]) == {"lovelace"} and not v.get("inlineDatum") and not v.get("datumhash")
              and not v.get("referenceScript")))
# The largest pays: the locked ADA (about 1.35), the fee (about 0.35) and a change output (about 1).
# Collateral covers 150% of the fee; the smallest other UTxO of at least 2 ADA is plenty.
pay = ada[-1] if ada and ada[-1][0] >= 3_000_000 else None
coll = [x for x in ada[:-1] if x[0] >= 2_000_000]
if not pay or not coll:
    sys.exit("The sponsor needs two ADA-only UTxOs: one of at least 3 ADA to pay, and another of at least 2 ADA for "
             "collateral. Send it two such outputs.")
print(pay[1], coll[0][1])
EOF
)
fi
# ADA locked with the registration token: the ledger minimum for this exact output (address, token, inline datum).
if [[ -z "${REG_LOVELACE:-}" ]]; then
  "$CLI" conway query protocol-parameters --socket-path "$SOCKET_PATH" --out-file protocol-params.json
  REG_LOVELACE="$("$CLI" conway transaction calculate-min-required-utxo --protocol-params-file protocol-params.json \
    --tx-out "$VALIDATOR_ADDR+0 + 1 $VALIDATOR_HASH" --tx-out-inline-datum-file "$DATUM" | tr -dc '0-9')"
fi
if ! [[ "$REG_LOVELACE" =~ ^[0-9]+$ ]] || (( REG_LOVELACE < 1000000 || REG_LOVELACE > 5000000 )); then
  echo "Registration ADA '$REG_LOVELACE' lovelace is not between 1 and 5 ADA. Stopping." >&2
  exit 1
fi

echo "Sponsor:     $SPONSOR_ADDR"
echo "Input:       $UTXO"
echo "Collateral:  $COLLATERAL"
echo "Stake key:   $STAKE_KEY_HASH (required signer, from datum.json)"
echo "Validator:   $VALIDATOR_ADDR"
echo "Locked:      $REG_LOVELACE lovelace with the registration token"

# Expire the transaction if it is not submitted soon (default 2 hours; a slot is 1 second on mainnet and preprod),
# so a signed copy cannot be used much later.
TTL_SLOTS="${TTL_SLOTS:-7200}"
TIP_SLOT="$("$CLI" conway query tip --socket-path "$SOCKET_PATH" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["slot"])')"
EXPIRES=$((TIP_SLOT + TTL_SLOTS))
echo "Expires:     slot $EXPIRES (tip $TIP_SLOT + $TTL_SLOTS)"

rm -f register.unsigned
# Output 0 must be the registration UTxO: the validator reads the first output.
# --witness-override 2: the fee covers the sponsor's and the cold stake key's signatures.
"$CLI" conway transaction build \
  --tx-in "$UTXO" \
  --tx-out "$VALIDATOR_ADDR+$REG_LOVELACE lovelace + 1 $VALIDATOR_HASH" \
  --tx-out-inline-datum-file "$DATUM" \
  --tx-in-collateral "$COLLATERAL" \
  --mint "1 $VALIDATOR_HASH" \
  --mint-script-file "$SCRIPT" \
  --mint-redeemer-file "$REDEEMER" \
  --change-address "$SPONSOR_ADDR" \
  --required-signer-hash "$STAKE_KEY_HASH" \
  --invalid-hereafter "$EXPIRES" \
  --witness-override 2 \
  --socket-path "$SOCKET_PATH" \
  --out-file register.unsigned

echo "Wrote register.unsigned (tx id $(txid register.unsigned))"

if [[ -f "$QR_SEND" ]]; then
  node "$QR_SEND" tx register.unsigned --html register-send.html
  echo "Open register-send.html and scan it on the cold machine (or copy register.unsigned by USB)."
else
  echo "qr-send.js not found at $QR_SEND (set QR_SEND); copy register.unsigned to the cold machine by USB."
fi

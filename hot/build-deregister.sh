#!/usr/bin/env bash
# HOT (online) machine. Builds the unsigned DUST deregistration for a cold wallet, paid for by a sponsor wallet.
# It spends the stake key's registration UTxO at the mapping validator and burns its registration token.
#
#   hot/build-deregister.sh <datum.json> <sponsor-payment.addr> [REGISTRATION_UTXO] [UTXO] [COLLATERAL]
#
# datum.json   from the cold page (dust-register-cold.html, step 2). Only its stake key hash is used, to find the
#              registration; the Dust public key in it does not matter here.
# sponsor .addr the sponsor's payment address file. It pays the fee and the collateral, and receives the ADA that was
#              locked with the registration token (about 1.35 ADA). With no UTXO/COLLATERAL given, two ADA-only UTxOs
#              of at least 2 ADA are picked: the largest pays, the smallest other one is the collateral.
# REGISTRATION_UTXO  txid#index of the registration to remove. Needed only when the stake key has several (the script
#              lists them, with the Dust key each one names). Pass "" to skip it when giving UTXO and COLLATERAL.
#
# To change the Dust address: deregister, wait until it is on chain, register again with the new Dust key
# (hot/build-register.sh with a datum.json made with the new Dust address), then move the cNIGHT
# (hot/build-move-cnight.sh). Do not register the new key first: with two registrations Midnight generates no DUST.
# After a deregistration alone, DUST keeps being generated until the cNIGHT moves.
#
# Writes deregister.unsigned and, if midnight-cold-hot is next to this repository, deregister-send.html (the QR codes
# for the cold page). The cold machine signs with the stake key only. Finish with:
#   hot/assemble-submit.sh cold-stake-deregister.witness <sponsor-payment.skey> datum.json deregister.unsigned
#
# Environment: CARDANO_CLI (path to cardano-cli), TTL_SLOTS (default 7200), CARDANO_NODE_NETWORK_ID (mainnet, or 1 for
#   preprod), SOCKET_PATH, MAPPING_VALIDATOR (.plutus, for preprod), SPEND_REDEEMER (JSON value of the spend redeemer,
#   default {} as in midnight-node's deregister.sh), QR_SEND (path to qr-send.js).
set -euo pipefail

CLI="${CARDANO_CLI:-cardano-cli}"
# cardano-cli 11 prints txid as JSON unless asked for text; older versions print text and lack the flag.
txid() { "$CLI" conway transaction txid --tx-file "$1" --output-text 2>/dev/null || "$CLI" conway transaction txid --tx-file "$1"; }

export CARDANO_NODE_NETWORK_ID="${CARDANO_NODE_NETWORK_ID:-mainnet}"
SOCKET_PATH="${SOCKET_PATH:-/ada/mainnet/db/node.socket}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
QR_SEND="${QR_SEND:-$HERE/../midnight-cold-hot/dist/qr-send.js}"
MAINNET_VALIDATOR=73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5

USAGE="usage: hot/build-deregister.sh <datum.json> <sponsor-payment.addr> [REGISTRATION_UTXO] [UTXO] [COLLATERAL]"
DATUM="${1:?$USAGE}"
SPONSOR_ADDR_FILE="${2:?$USAGE}"
REG_UTXO="${3:-}"
UTXO="${4:-}"
COLLATERAL="${5:-}"
SCRIPT="${MAPPING_VALIDATOR:-$HERE/mapping_validator.plutus}"
REDEEMER="$HERE/deregister_red.json"
SPEND_REDEEMER="${SPEND_REDEEMER:-{\}}"
SPONSOR_ADDR="$(< "$SPONSOR_ADDR_FILE")"

# Printed when the sponsor's UTxOs do not fit. The hot page shows the lines starting with "==> " as what to do next.
prepare_hint() {
  local addr skey
  addr="$(realpath "$SPONSOR_ADDR_FILE")"
  skey="$(dirname "$addr")/payment.skey"
  [[ -e "$skey" ]] || skey="<sponsor-payment.skey>"
  {
    echo "==> hot/prepare-sponsor.sh rearranges the sponsor's UTxOs into that shape; everything stays at the sponsor's address."
    echo "==> Run it in a terminal, type SUBMIT, wait about a minute for it to land, then build again:"
    echo "==> CARDANO_CLI='$CLI' CARDANO_NODE_NETWORK_ID='$CARDANO_NODE_NETWORK_ID' SOCKET_PATH='$SOCKET_PATH' '$HERE/hot/prepare-sponsor.sh' '$addr' '$skey'"
  } >&2
}

echo "Network: $CARDANO_NODE_NETWORK_ID"

if [[ -n "$REG_UTXO" && ! "$REG_UTXO" =~ ^[0-9a-f]{64}#[0-9]{1,4}$ ]]; then
  echo "REGISTRATION_UTXO '$REG_UTXO' is not txid#index. Stopping." >&2
  exit 1
fi

# The datum crossed the air gap: read only the stake key hash and check its shape.
STAKE_KEY_HASH="$(python3 -I - "$DATUM" <<'EOF'
import json, re, sys
d = json.load(open(sys.argv[1]))
h = d["fields"][0]["fields"][0]["bytes"]
if not (d["constructor"] == 0 and len(d["fields"]) == 2 and d["fields"][0]["constructor"] == 0 and re.fullmatch(r"[0-9a-f]{56}", h)):
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

# Find the stake key's registration(s): UTxOs at the validator holding one registration token, whose datum names it.
"$CLI" conway query utxo --address "$VALIDATOR_ADDR" --socket-path "$SOCKET_PATH" --output-json > validator-utxos.json
# Command substitution, not < <(...): a failure inside process substitution would not stop the script.
FOUND="$(python3 -I - validator-utxos.json "$VALIDATOR_HASH" "$STAKE_KEY_HASH" "$REG_UTXO" <<'EOF'
import json, sys
u, policy, stake, want = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3], sys.argv[4]
hits = []
for ref, v in sorted(u.items()):
    try:
        d = v["inlineDatum"]
        if d["fields"][0]["fields"][0]["bytes"] == stake and v["value"].get(policy) == {"": 1}:
            hits.append((ref, d["fields"][1]["bytes"], v["value"]["lovelace"]))
    except (KeyError, IndexError, TypeError):
        continue
for ref, dust, ada in hits:
    print(f"Registration {ref}: Dust public key {dust}, {ada} lovelace locked", file=sys.stderr)
if not hits:
    sys.exit(f"Stake key {stake} has no registration at the validator ({len(u)} registrations there). Nothing to deregister.")
if want:
    hits = [h for h in hits if h[0] == want]
    if not hits:
        sys.exit(f"{want} is not a registration of stake key {stake}.")
elif len(hits) > 1:
    sys.exit("This stake key has several registrations (Midnight generates no DUST while there is more than one). "
             "Pass the one to remove as the third argument (txid#index).")
print(*hits[0])
EOF
)"
read -r REG_UTXO REG_DUST REG_LOVELACE <<< "$FOUND"

if [[ -z "$UTXO" || -z "$COLLATERAL" ]]; then
  "$CLI" conway query utxo --address "$SPONSOR_ADDR" --socket-path "$SOCKET_PATH" --output-json > sponsor-utxos.json
  PICKED="$(python3 -I - sponsor-utxos.json <<'EOF'
import json, sys
u = json.load(open(sys.argv[1]))
# ADA-only UTxOs (no tokens, no datum, no script) of at least 2 ADA
ada = sorted(((v["value"]["lovelace"], k) for k, v in u.items()
              if set(v["value"]) == {"lovelace"} and not v.get("inlineDatum") and not v.get("datumhash")
              and not v.get("referenceScript") and v["value"]["lovelace"] >= 2_000_000))
# The largest pays the fee (about 0.4 ADA); the locked ADA comes back in the change. The smallest is the collateral.
if len(ada) < 2:
    sys.exit("The sponsor needs two ADA-only UTxOs of at least 2 ADA each: one to pay the fee, one for collateral.")
print(ada[-1][1], ada[0][1])
EOF
)" || { prepare_hint; exit 1; }
  read -r UTXO COLLATERAL <<< "$PICKED"
fi

echo "Sponsor:      $SPONSOR_ADDR (pays the fee, receives the locked ADA)"
echo "Input:        $UTXO"
echo "Collateral:   $COLLATERAL"
echo "Stake key:    $STAKE_KEY_HASH (required signer, from datum.json)"
echo "Validator:    $VALIDATOR_ADDR"
echo "Deregisters:  $REG_UTXO (Dust public key $REG_DUST, $REG_LOVELACE lovelace locked)"

# Expire the transaction if it is not submitted soon (default 2 hours; a slot is 1 second on mainnet and preprod).
TTL_SLOTS="${TTL_SLOTS:-7200}"
TIP_SLOT="$("$CLI" conway query tip --socket-path "$SOCKET_PATH" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["slot"])')"
EXPIRES=$((TIP_SLOT + TTL_SLOTS))
echo "Expires:      slot $EXPIRES (tip $TIP_SLOT + $TTL_SLOTS)"

rm -f deregister.unsigned
# No --tx-out: everything (the sponsor's input and the ADA that was locked, minus the fee) goes to the change address.
# --witness-override 2: the fee covers the sponsor's and the cold stake key's signatures.
"$CLI" conway transaction build \
  --tx-in "$UTXO" \
  --tx-in "$REG_UTXO" \
  --tx-in-script-file "$SCRIPT" \
  --tx-in-inline-datum-present \
  --tx-in-redeemer-value "$SPEND_REDEEMER" \
  --tx-in-collateral "$COLLATERAL" \
  --mint "-1 $VALIDATOR_HASH" \
  --mint-script-file "$SCRIPT" \
  --mint-redeemer-file "$REDEEMER" \
  --change-address "$SPONSOR_ADDR" \
  --required-signer-hash "$STAKE_KEY_HASH" \
  --invalid-hereafter "$EXPIRES" \
  --witness-override 2 \
  --socket-path "$SOCKET_PATH" \
  --out-file deregister.unsigned

echo "Wrote deregister.unsigned (tx id $(txid deregister.unsigned))"

if [[ -f "$QR_SEND" ]]; then
  node "$QR_SEND" tx deregister.unsigned --html deregister-send.html
  echo "Open deregister-send.html and scan it on the cold machine (or copy deregister.unsigned by USB)."
else
  echo "qr-send.js not found at $QR_SEND (set QR_SEND); copy deregister.unsigned to the cold machine by USB."
fi

#!/usr/bin/env bash
# HOT (online) machine. Rearranges the sponsor wallet's UTxOs into the shape the other hot scripts need: two ADA-only
# UTxOs, one for the collateral and a larger one that pays. Nothing leaves the sponsor's address.
#
#   hot/prepare-sponsor.sh <sponsor-payment.addr> <sponsor-payment.skey>
#
# It spends every plain sponsor UTxO (those with a datum or a reference script are left alone) and writes back, all to
# the sponsor's own address:
#   - one output of COLLATERAL_ADA (default 2 ADA), ADA only: the collateral;
#   - if the sponsor holds tokens (cNIGHT for example), one output with all of them and the ledger's minimum ADA;
#   - the change: all the remaining ADA, ADA only. This one pays the fee, and for a registration the locked ADA.
# It stops if the change would be under 2 ADA (a deregistration needs 2, a registration 3).
# If the sponsor already has two suitable UTxOs it does nothing; set FORCE=1 to rearrange anyway.
#
# The transaction is shown, then signed with the sponsor's key and submitted after you type SUBMIT.
# Writes prepare-sponsor.unsigned, prepare-sponsor.signed and prepare-sponsor-tx.hash.
#
# Requirements: cardano-cli and a synced cardano-node reachable through its node.socket. Set these before running:
#   CARDANO_CLI              path to cardano-cli, if it is not on your PATH (checked against cardano-cli 11.2.3)
#   SOCKET_PATH              the node's socket (default /ada/mainnet/db/node.socket)
#   CARDANO_NODE_NETWORK_ID  mainnet (the default), or 1 for preprod
#   COLLATERAL_ADA           the collateral output in ADA (default 2)
#   TTL_SLOTS                validity window in slots (default 7200); FORCE=1 rearranges even when not needed
#
# If the node runs on another machine, forward its socket to a local path over SSH first, in a separate terminal
# (it stays open until Ctrl-C; the remote user must be able to read and write the socket):
#
#   ssh -nNT -o StreamLocalBindUnlink=yes -L /tmp/mainnet.socket:/ada/mainnet/db/node.socket user@node-host
#
# then run, for example:
#
#   CARDANO_CLI=/path/to/cardano-cli SOCKET_PATH=/tmp/mainnet.socket \
#     hot/prepare-sponsor.sh payment.addr payment.skey
set -euo pipefail

CLI="${CARDANO_CLI:-cardano-cli}"
# cardano-cli 11 prints txid as JSON unless asked for text; older versions print text and lack the flag.
txid() { "$CLI" conway transaction txid --tx-file "$1" --output-text 2>/dev/null || "$CLI" conway transaction txid --tx-file "$1"; }

export CARDANO_NODE_NETWORK_ID="${CARDANO_NODE_NETWORK_ID:-mainnet}"
SOCKET_PATH="${SOCKET_PATH:-/ada/mainnet/db/node.socket}"
COLLATERAL_ADA="${COLLATERAL_ADA:-2}"

USAGE="usage: hot/prepare-sponsor.sh <sponsor-payment.addr> <sponsor-payment.skey>"
SPONSOR_ADDR="$(tr -d '[:space:]' < "${1:?$USAGE}")"
SPONSOR_SKEY="${2:?$USAGE}"

if [[ ! -S "$SOCKET_PATH" ]]; then
  echo "No node socket at $SOCKET_PATH. Set SOCKET_PATH, or forward a remote node's socket first:" >&2
  echo "  ssh -nNT -o StreamLocalBindUnlink=yes -L /tmp/mainnet.socket:/ada/mainnet/db/node.socket user@node-host" >&2
  exit 1
fi
command -v "$CLI" > /dev/null || { echo "cardano-cli not found ($CLI). Set CARDANO_CLI to its path." >&2; exit 1; }

echo "Network: $CARDANO_NODE_NETWORK_ID"
echo "Sponsor: $SPONSOR_ADDR"

"$CLI" conway query utxo --address "$SPONSOR_ADDR" --socket-path "$SOCKET_PATH" --output-json > sponsor-utxos.json
# Prints: line 1 "ready" or "split"; line 2 the collateral in lovelace; line 3 the token part of an output value
# (empty if no tokens); line 4 the total lovelace of the inputs; then one input per line.
# Command substitution, not < <(...): a failure inside process substitution would not stop the script.
PLAN="$(python3 -I - sponsor-utxos.json "$COLLATERAL_ADA" "${FORCE:-}" <<'EOF'
import json, sys
u, force = json.load(open(sys.argv[1])), sys.argv[3]
collateral = round(float(sys.argv[2]) * 1_000_000)
if collateral < 2_000_000:
    sys.exit("COLLATERAL_ADA must be at least 2.")
plain = {k: v["value"] for k, v in sorted(u.items())
         if not v.get("inlineDatum") and not v.get("datumhash") and not v.get("referenceScript")}
if not plain:
    sys.exit("The sponsor address has no UTxO to spend.")
tokens = {}
for k, val in plain.items():
    toks = [f"{sum(a.values())} token(s) of {p[:8]}…" for p, a in val.items() if p != "lovelace"]
    print(f"  {k}  {val['lovelace'] / 1e6:.6f} ADA" + ("  + " + ", ".join(toks) if toks else ""), file=sys.stderr)
    for p, assets in val.items():
        if p == "lovelace":
            continue
        for name, n in assets.items():
            tokens[(p, name)] = tokens.get((p, name), 0) + n
ada_only = sorted(v["lovelace"] for v in plain.values() if set(v) == {"lovelace"} and v["lovelace"] >= 2_000_000)
ready = len(ada_only) >= 2 and ada_only[-1] >= 3_000_000 and not force
print("ready" if ready else "split")
print(collateral)
print(" + ".join(f"{n} {p}.{name}" if name else f"{n} {p}" for (p, name), n in sorted(tokens.items())))
print(sum(v["lovelace"] for v in plain.values()))
print("\n".join(plain))
EOF
)"
mapfile -t P <<< "$PLAN"
if [[ "${P[0]}" == ready ]]; then
  echo "The sponsor already has two ADA-only UTxOs (one of at least 3 ADA, another of at least 2). Nothing to do."
  echo "Set FORCE=1 to rearrange anyway."
  exit 0
fi
COLLATERAL="${P[1]}"
TOKENS="${P[2]}"
TOTAL="${P[3]}"

TX_IN=()
for i in "${P[@]:4}"; do TX_IN+=(--tx-in "$i"); done
TX_OUT=(--tx-out "$SPONSOR_ADDR+$COLLATERAL")
TOKEN_LOVELACE=0
if [[ -n "$TOKENS" ]]; then
  "$CLI" conway query protocol-parameters --socket-path "$SOCKET_PATH" --out-file protocol-params.json
  TOKEN_LOVELACE="$("$CLI" conway transaction calculate-min-required-utxo --protocol-params-file protocol-params.json \
    --tx-out "$SPONSOR_ADDR+0 + $TOKENS" | tr -dc '0-9')"
  if ! [[ "$TOKEN_LOVELACE" =~ ^[0-9]+$ ]] || (( TOKEN_LOVELACE < 800000 || TOKEN_LOVELACE > 20000000 )); then
    echo "Minimum ADA for the token output '$TOKEN_LOVELACE' lovelace is not between 0.8 and 20 ADA. Stopping." >&2
    exit 1
  fi
  TX_OUT+=(--tx-out "$SPONSOR_ADDR+$TOKEN_LOVELACE + $TOKENS")
fi

ada() { python3 -I -c 'import sys; print(f"{int(sys.argv[1]) / 1e6:.6f}")' "$1"; }
# The fee is not known yet; 0.5 ADA is well above what this transaction costs.
REST=$((TOTAL - COLLATERAL - TOKEN_LOVELACE - 500000))
if (( REST < 2000000 )); then
  echo "Not enough ADA: $(ada "$TOTAL") in all, less $(ada "$COLLATERAL") collateral, $(ada "$TOKEN_LOVELACE") kept with the tokens and the fee" >&2
  echo "leaves under 2 ADA to pay with. Send the sponsor $(ada $((3000000 - REST))) ADA more (for a registration), then run this again." >&2
  exit 1
fi

TTL_SLOTS="${TTL_SLOTS:-7200}"
TIP_SLOT="$("$CLI" conway query tip --socket-path "$SOCKET_PATH" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["slot"])')"

rm -f prepare-sponsor.unsigned prepare-sponsor.signed
"$CLI" conway transaction build \
  "${TX_IN[@]}" \
  "${TX_OUT[@]}" \
  --change-address "$SPONSOR_ADDR" \
  --invalid-hereafter $((TIP_SLOT + TTL_SLOTS)) \
  --witness-override 1 \
  --socket-path "$SOCKET_PATH" \
  --out-file prepare-sponsor.unsigned

# Read the fee back from the body (map key 2) rather than trusting the estimate above.
FEE="$("$CLI" debug transaction view --tx-file prepare-sponsor.unsigned 2>/dev/null \
  | python3 -I -c 'import json,sys,re; print(re.sub(r"\D", "", str(json.load(sys.stdin)["fee"])))' 2>/dev/null || true)"
echo
echo "All outputs go to the sponsor's own address:"
echo "  collateral       $(ada "$COLLATERAL") ADA"
[[ -n "$TOKENS" ]] && echo "  tokens           $(ada "$TOKEN_LOVELACE") ADA + $TOKENS"
if [[ "$FEE" =~ ^[0-9]+$ ]]; then
  CHANGE=$((TOTAL - COLLATERAL - TOKEN_LOVELACE - FEE))
  echo "  pays (change)    $(ada "$CHANGE") ADA"
  echo "  fee              $(ada "$FEE") ADA"
  (( CHANGE < 3000000 )) && echo "Note: the paying UTxO is under 3 ADA: enough for a deregistration, not for a registration."
else
  echo "  pays (change)    the rest, about $(ada $((REST + 300000))) ADA"
fi

"$CLI" conway transaction sign --tx-body-file prepare-sponsor.unsigned --signing-key-file "$SPONSOR_SKEY" --out-file prepare-sponsor.signed
TXID="$(txid prepare-sponsor.signed)"
echo "Signed transaction: prepare-sponsor.signed (tx id $TXID)"
read -r -p "Type SUBMIT to send it to the $CARDANO_NODE_NETWORK_ID network: " answer
if [[ "$answer" != SUBMIT ]]; then
  echo "Not submitted."
  exit 1
fi
"$CLI" conway transaction submit --socket-path "$SOCKET_PATH" --tx-file prepare-sponsor.signed
echo "$TXID" > prepare-sponsor-tx.hash
echo "Submitted $TXID. Once it is on chain (about a minute), build the registration or deregistration again."

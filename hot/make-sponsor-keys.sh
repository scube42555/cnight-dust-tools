#!/usr/bin/env bash
# Make the sponsor's cardano-cli key files from its recovery phrase, for hot/build-register.sh and hot/assemble-submit.sh.
#
#   hot/make-sponsor-keys.sh --mainnet     (or no flag for preprod, testnet magic 1)
#
# Run it in your own terminal. It asks for the recovery phrase and optional passphrase without echoing them, keeps them
# only in shell variables, and writes to OUT_DIR (default: the current folder; keep it outside the repository):
#   payment.skey   the sponsor's payment signing key (m/1852'/1815'/0'/0/0)   <- secret, keep it on the hot machine
#   payment.vkey   its verification key
#   payment.addr   the wallet's first address (payment 0/0 + stake 2/0), which should match your wallet
# The stake signing key is made in a private temporary folder only to get the stake verification key, then deleted.
#
# Environment: CARDANO_CLI, CARDANO_ADDRESS (paths to the tools), OUT_DIR.
set -euo pipefail
umask 077

CLI="${CARDANO_CLI:-/home/scube/cardano/cardano-wallet/cardano-cli}"
CA="${CARDANO_ADDRESS:-/home/scube/cardano/cardano-wallet/cardano-address}"
OUT_DIR="${OUT_DIR:-$PWD}"
NETWORK=(--testnet-magic 1)
NETWORK_NAME=preprod
if [[ "${1:-}" == --mainnet ]]; then NETWORK=(--mainnet); NETWORK_NAME=mainnet; fi

for f in payment.skey payment.vkey payment.addr; do
  if [[ -e "$OUT_DIR/$f" ]]; then
    echo "$OUT_DIR/$f already exists; move it away first (this script never overwrites keys)." >&2
    exit 1
  fi
done

echo "Network: $NETWORK_NAME" >&2
read -rs -p "Recovery phrase (not shown): " PHRASE; echo >&2
read -rs -p "Passphrase, if your wallet has one (Enter for none): " PASS; echo >&2
PHRASE="$(echo $PHRASE)"  # collapse extra spaces and line breaks

if [[ -n "$PASS" ]]; then
  ROOT="$(printf '%s\n' "$PHRASE" | "$CA" key from-recovery-phrase Shelley --passphrase from-utf8 --from-file <(printf '%s' "$PASS"))"
else
  ROOT="$(printf '%s\n' "$PHRASE" | "$CA" key from-recovery-phrase Shelley)"
fi
unset PHRASE PASS

TMP="$(mktemp -d)"
cleanup() { rm -f -- "$TMP/stake.skey" "$TMP/stake.xvkey" "$TMP/stake.vkey" "$TMP/payment.xvkey"; rmdir -- "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

"$CLI" conway key convert-cardano-address-key --shelley-payment-key \
  --signing-key-file <(printf '%s' "$ROOT" | "$CA" key child 1852H/1815H/0H/0/0) --out-file "$OUT_DIR/payment.skey"
"$CLI" conway key convert-cardano-address-key --shelley-stake-key \
  --signing-key-file <(printf '%s' "$ROOT" | "$CA" key child 1852H/1815H/0H/2/0) --out-file "$TMP/stake.skey"
unset ROOT

"$CLI" conway key verification-key --signing-key-file "$OUT_DIR/payment.skey" --verification-key-file "$TMP/payment.xvkey"
"$CLI" conway key non-extended-key --extended-verification-key-file "$TMP/payment.xvkey" --verification-key-file "$OUT_DIR/payment.vkey"
"$CLI" conway key verification-key --signing-key-file "$TMP/stake.skey" --verification-key-file "$TMP/stake.xvkey"
"$CLI" conway key non-extended-key --extended-verification-key-file "$TMP/stake.xvkey" --verification-key-file "$TMP/stake.vkey"
"$CLI" conway address build --payment-verification-key-file "$OUT_DIR/payment.vkey" \
  --stake-verification-key-file "$TMP/stake.vkey" "${NETWORK[@]}" --out-file "$OUT_DIR/payment.addr"
rm -f -- "$TMP/stake.vkey"

echo "Wrote $OUT_DIR/payment.skey, payment.vkey, payment.addr"
echo "Address: $(cat "$OUT_DIR/payment.addr")"
echo "Check that this is the first receiving address in your wallet. If it is not, the phrase or passphrase differs."

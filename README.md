# mainnet-dust-generation-scripts

Registers the cNIGHT held by a Cardano stake key for DUST generation on Midnight. There are two ways to do it:

- **Cold/hot with a sponsor** (new, recommended for keys kept offline): the stake key signs on an offline machine in
  one HTML page. A sponsor wallet on the online machine pays the locked ADA, fee and collateral. No collateral transaction,
  and the cold wallet needs no ADA.
- **Original scripts** (below): cardano-cli on one machine, the wallet pays for everything.

## Cold/hot registration with a sponsor

| Machine | What runs there |
|---|---|
| Cold (offline) | `dust-register-cold.html`: one self-contained page, no network access (CSP `connect-src 'none'`) |
| Hot (online) | `hot/build-register.sh`, `hot/assemble-submit.sh`: cardano-cli with your node; the sponsor's keys |

Two transactions, both signed on the cold machine:

- **Registration**: only the cold **stake key** signs (the validator's `check_auth` looks for it in the required
  signers). The cNIGHT does not move.
- **Start generation** (after the registration is on chain): generation starts when cNIGHT moves into a new UTxO
  under the registered stake key. Either send cNIGHT to the cold address from another wallet (nothing to sign on the
  cold machine), or do the optional self-send below, signed by the cold **payment key**.

1. **Cold:** open `dust-register-cold.html` and enter the recovery phrase (and passphrase, if any). Check that the
   Cardano address, stake address and Midnight Dust address it shows are the ones in your wallets.
2. **Cold → hot:** send the datum (stake key hash + Dust public key): download `datum.json`, or show it as a QR code
   and receive it with midnight-cold-hot's `receiver.html` or `tools/qr_scan.py`, then `node dist/qr-decode.js`.
3. **Hot:** `hot/build-register.sh datum.json sponsor-payment.addr`. It picks two ADA-only sponsor UTxOs, the
   largest (at least 3 ADA) to pay and another of at least 2 ADA for collateral, or you pass them as arguments. It builds `register.unsigned`
   and writes `register-send.html` (12 or so cycling QR codes, via midnight-cold-hot's `qr-send.js`).
4. **Hot → cold:** scan with `python3 tools/qr_scan.py` (midnight-cold-hot) and load the `.mqr` file in the page, or
   load `register.unsigned` from USB, or use the page's camera button if the browser can use the camera.
5. **Cold:** the page decodes the transaction and checks it. It refuses to sign if anything is off: certificates,
   withdrawals, governance or donation fields, unknown fields, a datum naming another stake key or Dust key, output 0
   not going to the mapping validator with exactly one token, any mint other than one registration token, a deregister
   redeemer, a missing required signer, or the wrong network. Type `SIGN` and it produces `cold-stake.witness`
   (one QR code).
6. **Hot:** `hot/assemble-submit.sh cold-stake.witness sponsor-payment.skey` (or pass the received `.mqr`). It
   checks that the witness key is the stake key in `datum.json`, adds the sponsor signature, and submits after you type
   `SUBMIT`.
7. **Start generation**, once the registration is on chain. The simple way: send cNIGHT from another wallet to the
   address in the page's step 2 (it must carry the registered stake key), and skip to step 10. Or self-send (7–9):
   **Hot:** `hot/build-move-cnight.sh cold.addr [sponsor-payment.addr]`. `cold.addr`
   is the address from the page's step 2 (set *Address index* in step 1 if your cNIGHT sits on another receiving
   address). It spends every cNIGHT UTxO at that address and sends everything back to it, writing
   `move-cnight.unsigned` and `move-cnight-send.html`. Without a sponsor, the cold wallet pays the fee (about 0.2 ADA)
   from the ADA on its cNIGHT UTxOs. With a sponsor, one small ADA-only sponsor UTxO (1 to `GIFT_MAX_ADA`=5 ADA, or
   `SPONSOR_UTXO`) is added, and its whole value goes to the cold wallet and pays the fee.
8. **Cold:** load it in step 3 like the registration. The page sees that nothing is minted and checks it as a
   self-send. It signs only if **every output goes to your own address** (same payment key and stake key) and holds
   the cNIGHT, the fee is at most 2 ADA, and there are no certificates, withdrawals, mints, scripts, collateral,
   datums, reference inputs, other required signers or governance fields. The page cannot see what the inputs hold,
   and does not need to: whatever they hold comes back to you, minus the fee. It produces `cold-payment.witness`.
9. **Hot:** `hot/submit-move-cnight.sh cold-payment.witness cold.addr [sponsor-payment.skey]` (pass the sponsor key if
   a sponsor UTxO was used). It checks that the witness key is the payment key of `cold.addr`, and submits after you
   type `SUBMIT`.
10. DUST should start to appear at the Dust address the page shows about 12 hours later.

### Mainnet

Mainnet is the default everywhere; nothing needs to be set for the network except the node socket.

- **Cold page:** *Network: Mainnet* (the default). The mapping validator `73e4aea3…` and the cNIGHT policy `0691b2fe…`
  are fixed and cannot be edited. Copy `dust-register-cold.html` to the cold machine and compare its SHA-256 with the
  one `cold-page/build.sh` printed.
- **Sponsor keys:** in a folder outside the repository (or `mainnet/`, which git ignores), run
  `hot/make-sponsor-keys.sh --mainnet`. Check that `payment.addr` is the first address of the sponsor wallet.
- **Sponsor funds:** two ADA-only UTxOs, one of at least 3 ADA and another of at least 2 ADA. The registration costs the sponsor about 1.7 ADA: the ledger
  minimum for the registration output (1.353340 ADA with mainnet's current parameters) stays with the registration token
  at the validator address, plus the fee (0.34 ADA on preprod). Set `REG_LOVELACE` to lock a different amount (1 to 5 ADA). The collateral is only taken if the
  script fails, which `transaction build` checks before you sign.
- **Hot scripts:** run them in the folder that holds `datum.json` and the keys, with `SOCKET_PATH` set to your mainnet
  node's socket (default `/ada/mainnet/db/node.socket`) and `CARDANO_CLI` if needed. Leave `CARDANO_NODE_NETWORK_ID` and
  `MAPPING_VALIDATOR` unset: `build-register.sh` stops if the validator does not hash to `73e4aea3…`.
- **Order:** registration first; start generation only after the registration UTxO is on chain.

### Preprod

For preprod, pick *Preprod* in the page: the preprod mapping validator hash `7e69087d…` is built in (the validator of
midnight-node `scripts/cnight-generates-dust`, whose preprod address held 57 registrations on 12 Nov 2026). To use another,
paste its hash or load its `.plutus` file, directly or as an `.mqr` of QR frames (`qr-send.js plutus <file>`, about 11 codes).
On the hot side, set `CARDANO_NODE_NETWORK_ID=1`, `SOCKET_PATH`, and `MAPPING_VALIDATOR=<preprod .plutus>`.
Set `CARDANO_CLI` if cardano-cli is not on your PATH (the scripts are checked against cardano-cli 11.2.3).

The cNIGHT policy is built in: mainnet `0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa` (the mainnet mapping
validator names this policy in its own script bytes), preprod `d2dbff622e509dda256fedbd31ef6e9fd98ed49ad91d5c0e07f68af1`
(editable in the page; `CNIGHT_POLICY` for the hot scripts).

### What has been verified

| Check | Status |
|---|---|
| Stake address, base address, Dust public key and Dust address match revised-iancoleman.io's WASM (test mnemonic, mainnet and preprod, with and without passphrase) | Passed |
| Script hash = blake2b-224(0x03 ‖ cborHex bytes): reproduces the known hash `7e69087d…` and the address of midnight-node's testnet validator | Passed |
| Mainnet mapping validator: hash `73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5`, address `addr1w9e7ft4rrdd4rkdseguxr9hudfxyytm5ckh2qy0yhz7lfeg9lvhq7` | Passed: same as `cardano-cli hash script` / `address build` (11.2.3) |
| A registration built by cardano-cli 11.2.3 (`build-raw`, placeholder protocol parameters, never submitted) passes all checks; the page's body hash equals `transaction txid`; cardano-cli `assemble` accepts the page's witness; both signatures in the assembled transaction verify | Passed |
| `hot/assemble-submit.sh` offline up to the SUBMIT prompt (witness check, sponsor witness, assemble, txid) | Passed |
| Body hash: the signatures in a real cardano-cli signed transaction verify against the page's body hash | Passed |
| Transaction checks: a synthetic registration passes; 16 malicious variants and malformed CBOR are refused | Passed (`node --test cold-page/tests/`) |
| MQR1 frames interoperate with midnight-cold-hot `mqr.js` / `qr-decode.js` in both directions; drawn QR codes read back with jsQR | Passed |
| Whole page flow in headless Chromium (derive, 12-frame transfer, checks, sign, witness verifies with Node's ed25519); page loads in Firefox | Passed |
| `hot/build-register.sh` and `hot/assemble-submit.sh` against a preprod node | Passed |
| A full registration on preprod: token and datum at the validator address, collateral not taken | Passed |
| Payment key (m/1852'/1815'/0'/0/i) matches cardano-address for i = 0 and 3 (test mnemonic) | Passed |
| `hot/build-move-cnight.sh` against preprod, with and without a sponsor gift input: the page's self-send checks pass on both, body hash = `transaction txid` | Passed (built only; the test address was not the cold wallet) |
| Self-send checks: 19 bad variants refused (other addresses, same stake key with another payment key, no cNIGHT, high fee, mint, scripts, collateral, certificates, withdrawals, datums, other signers, wrong network) | Passed (`node --test cold-page/tests/`) |
| Page in headless Chromium: self-send built by cardano-cli is recognised, checked and signed with the payment key; cardano-cli assembles the witness and the signature verifies; registration path unchanged | Passed |
| `hot/submit-move-cnight.sh` offline up to the SUBMIT prompt; refuses a witness from another payment key | Passed |
| Mainnet validator vs the preprod one used on chain: decoded to UPLC, the programs are identical except one conditional next to the `one_shot_ref` code, which excludes the cNIGHT policy (mainnet: `0691b2fe…` and the bytes `mainnet`; preprod: `d2dbff62…`) | Checked |
| cardano-cli `calculate-plutus-script-cost offline` on a mainnet-shaped registration: the mainnet validator accepts it with the same execution units as the preprod validator (80,108 memory, 28,929,016 steps), so the registration takes the same path; it rejects a datum naming another stake key | Passed |
| A cNIGHT self-send on preprod: both cNIGHT UTxOs spent, all cNIGHT in one new UTxO at the cold address, cold wallet paid the 0.17 ADA fee | Passed |
| DUST appears at the Dust address (about 12 hours after the self-send) | **Not yet confirmed** |
| `hot/build-register.sh` against a mainnet node: `transaction build` runs the mainnet validator on live chain data and it passes; 1.353340 ADA locked (ledger minimum), fee 0.344 ADA; the cold page's mainnet checks all pass | Passed |
| A full registration on mainnet: token, 1.353340 ADA and the datum at the mainnet validator address; collateral not taken | Passed |

### Building the page

`cold-page/build.sh` (Rust with the wasm32 target, wasm-bindgen-cli 0.2.100, Python 3) rebuilds the WASM module and
writes `dust-register-cold.html`, printing its SHA-256 so you can compare copies. The crate uses the same pinned crates
and `Cargo.lock` as revised-iancoleman.io (midnight-ledger rev `9f9842e`). The vendored libraries in `cold-page/vendor/`
(fflate 0.8.3, qrcode-generator 1.4.4, jsQR 1.4.0) are copied from midnight-cold-hot's `node_modules`. Tests:
`node --test cold-page/tests/` (add `COLD_TEST_SIGNED_TX=<signed tx file>` to include the real-transaction check).

## Original scripts (single machine, cardano-cli)

1) update datum json with your 28-byte stake key hash and 33-byte dust public key (28-byte stake key hash via: 'echo "stake1u9..." | cardano-address address inspect')
2) run mkHashes.sh to create mapping_validator hash and address files
3) edit mkCollateral.sh with proper UTXO to be used for collateral
4) run mkCollateral.sh
5) edit register.sh with created collateral UTXO and another UTXO with enough ADA to cover transaction cost of minting, etc.
6) if signing offline then perform the build-transaction step in register.sh from ONLINE machine and transfer built transaction to OFFLINE machine to sign, then transfer signed TX back
    to ONLINE machine to submit to mainnet node, else run register.sh from ONLINE machine
7) once registraton lands on mainnet then generation starts once that stake key actually moves cNIGHT. Either send cNIGHT to wallet in order to trigger the generation
    or if cNIGHT already in wallet then perform a self-send (send it to yourself).
8) Dust should begin to get generated roughly 12 hours afterwards

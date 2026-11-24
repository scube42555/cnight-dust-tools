# cnight-dust-tools

Registers the cNIGHT held by a Cardano stake key for DUST generation on Midnight, removes a registration, and changes
the Dust address the DUST goes to (see [Deregistering and changing the Dust address](#deregistering-and-changing-the-dust-address)).
There are two ways to register:

- **Cold/hot with a sponsor** (new, recommended for keys kept offline): the stake key signs on an offline machine in
  one HTML page. A sponsor wallet on the online machine pays the locked ADA, fee and collateral. No collateral transaction,
  and the cold wallet needs no ADA.
- **Original scripts** (below): cardano-cli on one machine, the wallet pays for everything.

## Cold/hot registration with a sponsor

| Machine | What runs there |
|---|---|
| Cold (offline) | `dust-register-cold.html`: one self-contained page, no network access (CSP `connect-src 'none'`) |
| Hot (online) | `hot/hot-server.py` and its page, or the scripts in `hot/` directly: cardano-cli with your node; the sponsor's keys |

Two transactions, both signed on the cold machine:

- **Registration**: only the cold **stake key** signs (the validator's `check_auth` looks for it in the required
  signers). The cNIGHT does not move.
- **Start generation** (after the registration is on chain): generation starts when cNIGHT moves into a new UTxO
  under the registered stake key. Either send cNIGHT to the cold address from another wallet (nothing to sign on the
  cold machine), or do the optional self-send below, signed by the cold **payment key**.

1. **Cold:** open `dust-register-cold.html` and enter the recovery phrase (and passphrase, if any). Check that the
   Cardano address, stake address and Midnight Dust address it shows are the ones in your wallets.
2. **Cold → hot:** send the datum (stake key hash + Dust public key): download `datum.json`, or show it as a QR code
   and scan it with the hot page's camera.
3. **Hot:** `hot/build-register.sh datum.json sponsor-payment.addr`. It picks two ADA-only sponsor UTxOs, the
   largest (at least 3 ADA) to pay and another of at least 2 ADA for collateral, or you pass them as arguments. It builds `register.unsigned`
   and writes `register-send.html` (12 or so cycling QR codes, via midnight-cold-hot's `qr-send.js`).
4. **Hot → cold:** scan with `tools/qr_scan.py` (see [QR scanner for the cold machine](#qr-scanner-for-the-cold-machine)) and drop the `.mqr` file on the page, or
   run it with `--clipboard` and paste the frames into the page's text box (the check runs as soon as you paste). Or
   drop `register.unsigned` from USB on the page, or use the page's camera button if the browser can use the camera.
5. **Cold:** the page decodes the transaction and checks it. It refuses to sign if anything is off: certificates,
   withdrawals, governance or donation fields, unknown fields, a datum naming another stake key or a Dust key other than the one shown in step 1, output 0
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

### Deregistering and changing the Dust address

What the chain allows:

- **Deregistering** spends the registration UTxO at the mapping validator and burns its token, signed by the stake
  key. The ADA that was locked with it (about 1.35 ADA) comes back; here it goes to the sponsor, who pays the fee.
- The validator has **no way to update** a registration. To change the Dust address you deregister, then register
  again with the new Dust address.
- Midnight generates DUST for a stake key only while it has **exactly one** registration. So deregister first and
  register second; never the other way round.
- cNIGHT UTxOs keep the Dust address they were created under. After a deregistration, DUST keeps being generated
  until the cNIGHT moves. After a new registration, the cNIGHT must move again before DUST goes to the new address.

**Deregister** (one transaction, signed by the cold stake key):

1. **Cold:** derive the keys as for a registration and send `datum.json` to the hot machine. Only its stake key
   hash is used here.
2. **Hot:** `hot/build-deregister.sh datum.json sponsor-payment.addr`. It finds the stake key's registration at the
   validator and prints the Dust key it names. If the stake key has several registrations, it lists them and you
   pass the one to remove as a third argument (`txid#index`). The sponsor needs two ADA-only UTxOs of at least 2 ADA.
   It writes `deregister.unsigned` (and `deregister-send.html`).
3. **Cold:** load it in step 3. The page sees the burn and checks it as a deregistration. It signs only if exactly one
   registration token is burned and nothing is minted, no output goes to the validator or holds a registration token,
   the redeemers are the deregister redeemer and one script spend, your stake key is a required signer, and there are
   no certificates, withdrawals, governance fields, other scripts or unknown fields. The page cannot see which
   UTxO is spent; the validator accepts your stake-key signature only for a registration of your own stake key.
   It produces `cold-stake-deregister.witness`.
4. **Hot:** `hot/assemble-submit.sh cold-stake-deregister.witness sponsor-payment.skey datum.json deregister.unsigned`,
   then type `SUBMIT`.
5. To stop DUST generation, move the cNIGHT once the deregistration is on chain (steps 7 to 9 above, or send it to
   another wallet).

**Change the Dust address** (three transactions):

1. Deregister, as above, and wait until it is on chain.
2. Register again with the new Dust address. On the cold page, step 1, enter it in *Dust address that receives the
   DUST* and derive the keys again. The page checks that it is a Dust address of the chosen network, shows it next
   to the wallet's own Dust address with a warning, and puts its public key in `datum.json`. Then follow steps 2 to 6
   of the registration with that datum. The page refuses a registration whose datum names any other Dust key. Leave
   the field empty to register the wallet's own Dust address.
3. Once the registration is on chain, move the cNIGHT (steps 7 to 9 above). DUST starts at the new address about
   12 hours later.

The page cannot tell whose Dust address you entered. Compare it with the receiving Midnight wallet before signing.

### Hot page

Instead of running the hot scripts by hand, start the local hot page in the folder that holds the sponsor's
`payment.addr` and `payment.skey`:

```bash
python3 hot/hot-server.py --dir mainnet --socket /tmp/mainnet.socket --cli /path/to/cardano-cli
# preprod: --network preprod --validator <preprod mapping validator .plutus>
```

Open the URL it prints. The page shows the network, the node's sync and the sponsor's ADA, and has three tabs,
*Registration*, *Start generation (optional self-send)* and *Deregister / change Dust address*. Each tab has four steps:
1. Receive the datum or the cold address: camera, dropped file or pasted QR frames.
2. Build with your node. The page shows the transaction, runs the same checks the cold page will run, and shows it
   as cycling QR codes, with buttons for a slower or faster cycle.
3. Receive the cold witness: camera, drop or paste. The page checks it and assembles the transaction.
4. Type `SUBMIT`, then the page watches the chain until the transaction lands.

The registration tab also says whether the stake key is already registered. The deregister tab lists the stake
key's registrations with the Dust key each one names, and asks which to remove when there are several.

All the Cardano work is done by the scripts in `hot/`, run with fixed arguments. The server never reads
`payment.skey`; it passes its path to the scripts. It listens on 127.0.0.1 only. Every request needs the token from
the printed URL, and requests whose Host or Origin header is not the server itself are refused, so other web pages
in the same browser cannot drive it. Building again renames the previous transaction, witness and signed files to
`*.old`.

*Refresh node and sponsor* only reads the node's tip and the sponsor's UTxOs again (for example after funding the
sponsor or running `hot/prepare-sponsor.sh`). *Clear and start over* renames the received datum, cold address,
witnesses and built or signed transactions to `*.old` and reloads the page empty; the sponsor's keys and address stay,
and nothing on chain changes.

### QR scanner for the cold machine

Tor Browser on Tails does not give pages the camera, so the cold page's camera button cannot work there. Instead,
`tools/qr_scan.py` reads the hot page's QR codes with OpenCV and writes a `received-tx-XXXXXX.mqr` file, which you
drop on the cold page (or, with `--clipboard`, paste into it). The cold page decodes and checks the frames itself, so
the cold machine needs no Node. The other direction needs no scanner: the hot page reads the cold page's QR codes
with the hot machine's camera. `tools/qr_scan.py` and `tools/fetch-python-QR-libs.sh` are copied from
midnight-cold-hot; both scanners read the same frames, so one scanner and one `pylibs` folder serve both projects.

The cold machine needs only these, in one flat folder:

```
cold-bundle/
  pylibs/                   OpenCV and NumPy, unzipped (about 270 MB)
  qr_scan.py                from tools/
  dust-register-cold.html   this project's cold page
  cold-page.html            midnight-cold-hot's cold page (its dist/cold-page.html), if you use it too
```

**On the online machine.** Fetch the libraries once, and again whenever the cold machine's Python version changes
(`PYVER` is what `python3 --version` prints there, without the last number). Nothing is installed and no install
script runs: the wheels are only unzipped.

```bash
PYVER=3.9 tools/fetch-python-QR-libs.sh ~/cold-bundle/pylibs
cp tools/qr_scan.py dust-register-cold.html ~/cold-bundle/
sha256sum ~/cold-bundle/dust-register-cold.html   # compare with what cold-page/build.sh printed
```

Add midnight-cold-hot's `dist/cold-page.html` if you use it, then copy `~/cold-bundle` to the USB stick.

**On Tails.** The home folder is in RAM, so copy the bundle in again after each reboot. Run the scanner from the
folder where you want the `.mqr` files:

```bash
cp -r /media/amnesia/<usb stick>/cold-bundle ~/
cd ~/cold-bundle
PYTHONPATH=~/cold-bundle/pylibs python3 -c "import cv2, numpy; print(cv2.__version__)"
PYTHONPATH=~/cold-bundle/pylibs python3 qr_scan.py --preview      # add --clipboard to paste instead of dropping
```

Open `dust-register-cold.html` (or `cold-page.html`) in Tor Browser and drop the `.mqr` file on it, or paste the
frames. The pages need JavaScript and WebAssembly, which Tor Browser's *Standard* security level allows (shield icon in
the toolbar, or Settings → Privacy & Security → Security Level); they cannot reach the network at any level.

### Node socket and cardano-cli

Every hot script and the hot page need cardano-cli and a synced cardano-node, reached through the node's
`node.socket`. Set `CARDANO_CLI` to the path of cardano-cli if it is not on your PATH, and `SOCKET_PATH` to the socket
(default `/ada/mainnet/db/node.socket`).

If the node runs on another machine, forward its socket to a local path over SSH, in a separate terminal that stays
open while you work (Ctrl-C closes it). The remote user must be able to read and write the socket:

```bash
ssh -nNT -o StreamLocalBindUnlink=yes -L /tmp/mainnet.socket:/ada/mainnet/db/node.socket user@node-host
```

Then point the scripts at the local end:

```bash
export CARDANO_CLI=/path/to/cardano-cli
export SOCKET_PATH=/tmp/mainnet.socket
"$CARDANO_CLI" conway query tip --socket-path "$SOCKET_PATH" --mainnet   # check the node answers and is synced
hot/sweep-address.sh payment.addr payment.skey <destination>
```

The hot page takes the same socket with `--socket /tmp/mainnet.socket`. For preprod, forward the preprod node's
socket (for example to `/tmp/preprod.socket`) and set `CARDANO_NODE_NETWORK_ID=1`.

### Mainnet

Mainnet is the default everywhere; nothing needs to be set for the network except the node socket (see
[Node socket and cardano-cli](#node-socket-and-cardano-cli)).

- **Cold page:** *Network: Mainnet* (the default). The mapping validator `73e4aea3…` and the cNIGHT policy `0691b2fe…`
  are fixed and cannot be edited. Copy `dust-register-cold.html` to the cold machine and compare its SHA-256 with the
  one `cold-page/build.sh` printed.
- **Sponsor keys:** in a folder outside the repository (or `mainnet/`, which git ignores), run
  `hot/make-sponsor-keys.sh --mainnet`. Check that `payment.addr` is the first address of the sponsor wallet.
- **Sponsor funds:** two ADA-only UTxOs, one of at least 3 ADA and another of at least 2 ADA. The registration costs the sponsor about 1.7 ADA: the ledger
  minimum for the registration output (1.353340 ADA with mainnet's current parameters) stays with the registration token
  at the validator address, plus the fee (0.34 ADA on preprod). Set `REG_LOVELACE` to lock a different amount (1 to 5 ADA). The collateral is only taken if the
  script fails, which `transaction build` checks before you sign.
  If the sponsor's ADA is not split that way (one UTxO only, or ADA sitting with tokens such as cNIGHT), run
  `hot/prepare-sponsor.sh payment.addr payment.skey`: it sends everything back to the sponsor's own address as a 2 ADA
  collateral UTxO, one UTxO holding any tokens with the minimum ADA, and the rest as the paying UTxO, after a typed SUBMIT.
  It needs `CARDANO_CLI` and `SOCKET_PATH` set, with the socket forwarded over SSH if the node is remote (see
  [Node socket and cardano-cli](#node-socket-and-cardano-cli)).
- **Emptying the sponsor:** `hot/sweep-address.sh payment.addr payment.skey <destination>` sends every UTxO at the
  address (all its ADA and tokens, less the fee) to the destination in one transaction, after you type the
  destination's last 8 characters and then SUBMIT. It refuses a destination on another network or at a script address.
  Staking rewards and the stake key deposit are not UTxOs and stay with the stake key; the cold wallet cannot be swept
  this way (its key is on the cold machine). It needs `CARDANO_CLI` and `SOCKET_PATH` set, with the socket forwarded
  over SSH if the node is remote (see [Node socket and cardano-cli](#node-socket-and-cardano-cli)).
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
| Page in headless Chromium: a dropped `.mqr` or `.unsigned` is loaded and checked; a `.plutus` dropped on the validator row sets the hash; pasted frames are checked at once; a drop before the keys are derived or of two files is refused; a stray drop does not leave the page | Passed |
| midnight-cold-hot `qr_scan.py --clipboard` with a fake camera and fake clipboard tools | Passed; not yet run with a real clipboard |
| `tools/qr_scan.py` (the copy in this repo) with a fake camera: 27 frames made by the cold page's own code, in random order with a stray QR code, collected with checksum OK; the `.mqr` it wrote decodes with the cold page's code to the same bytes | Passed (no real camera; midnight-cold-hot's copy is used on Tails with `--preview` and `--clipboard`) |
| Mainnet validator vs the preprod one used on chain: decoded to UPLC, the programs are identical except one conditional next to the `one_shot_ref` code, which excludes the cNIGHT policy (mainnet: `0691b2fe…` and the bytes `mainnet`; preprod: `d2dbff62…`) | Checked |
| cardano-cli `calculate-plutus-script-cost offline` on a mainnet-shaped registration: the mainnet validator accepts it with the same execution units as the preprod validator (80,108 memory, 28,929,016 steps), so the registration takes the same path; it rejects a datum naming another stake key | Passed |
| Hot page in headless Chromium against preprod (scratch folder, throwaway sponsor key, test mnemonic, never submitted): datum received as QR frames, registration built and checked, 14 QR frames shown, witness received, assembled with the same txid; wrong confirmations and a txid not matching the assembled transaction refused; self-send built for the preprod cold wallet and its checks pass | Passed |
| Hot server refuses requests without the token, from another Origin, with another Host (DNS rebinding), and writes only its four input files | Passed |
| `hot/sweep-address.sh`: against a **stub** cardano-cli, a build missing a token, a destination on another network, at a script address or equal to the source, a key that is not the source's and an empty source are refused; run by hand, every UTxO at the source went to the destination and the source address was left empty | Passed |
| Hot page *Clear and start over* against a **stub** cardano-cli: the received and built files are renamed to `*.old`, the sponsor's files stay, the page reloads empty with its token, and a request without the token is refused | Passed |
| Hot page submission and landing watch | Passed (run by hand on preprod and mainnet) |
| A cNIGHT self-send on preprod: both cNIGHT UTxOs spent, all cNIGHT in one new UTxO at the cold address, cold wallet paid the 0.17 ADA fee | Passed |
| DUST appears at the Dust address (about 12 hours after the self-send) | **Not yet confirmed** |
| Deregistration checks: a synthetic deregistration passes; 28 bad variants refused (wrong burn, extra mint, output to the validator or holding a token, wrong or missing redeemers, other scripts, certificates, withdrawals, votes, missing signer, no collateral, wrong network, marked invalid); the three kinds are told apart and each fails the others' checks | Passed (`node --test cold-page/tests/`) |
| Dust address field: the WASM decoder returns the public key of a Dust address and refuses another network, plain bech32, a Cardano address, a typo and a truncated address; a registration naming the entered key passes and one naming the wallet's own key is then refused | Passed (`node --test cold-page/tests/`) |
| Page in headless Chromium (test mnemonic, synthetic transactions): an entered Dust address is shown with the warning and used in the datum; a deregistration is recognised, checked and signed with the stake key (`cold-stake-deregister.witness`); registration and self-send unchanged | Passed |
| `hot/build-deregister.sh`, `hot/assemble-submit.sh` and the hot server's deregister flow against a **stub** cardano-cli (fake chain data, no node): the registration is found by stake key and token, several registrations need a choice, another key's registration and a malformed reference are refused, the witness is checked, wrong confirmations and a wrong txid are refused | Passed |
| `hot/build-deregister.sh` against a preprod node (cardano-cli 11.2.3): it finds the test registration, `transaction build` runs the validator on live chain data and it accepts the spend redeemer `{}` and the burn; fee 0.342 ADA; the cold page's deregistration checks all pass and its body hash equals `transaction txid` | Passed (built only, not submitted) |
| A deregistration on preprod, then a registration with another Dust address entered on the cold page: the stake key has exactly one registration at the validator, naming the new Dust key, 1.353340 ADA locked | Passed |
| DUST appears at the new Dust address after the re-registration (cNIGHT sent to the cold address from another wallet) | Passed (preprod) |
| Hot page's deregister tab in a browser against preprod: build, QR, witness, submit, landing watch | Passed (run by hand) |
| `hot/build-register.sh` against a mainnet node: `transaction build` runs the mainnet validator on live chain data and it passes; 1.353340 ADA locked (ledger minimum), fee 0.344 ADA; the cold page's mainnet checks all pass | Passed |
| A full registration on mainnet: token, 1.353340 ADA and the datum at the mainnet validator address; collateral not taken | Passed |
| `hot/prepare-sponsor.sh` on mainnet: one ADA-only UTxO and one holding cNIGHT became a 2 ADA collateral UTxO, a UTxO with the cNIGHT and the minimum ADA, and the paying UTxO; fee 0.18 ADA | Passed |
| A deregistration on mainnet through the hot page: the mainnet validator accepts the spend redeemer `{}` and the burn, the locked ADA comes back to the sponsor, collateral not taken, fee 0.34 ADA; then a registration with another Dust address (1.353340 ADA locked, fee 0.34 ADA). In this test the cold wallet was also the sponsor | Passed |
| A cNIGHT self-send on mainnet with a sponsor gift (without it the build is refused: the cNIGHT UTxO held too little ADA to pay the fee): all cNIGHT in one new UTxO at the cold address, fee 0.18 ADA | Passed |
| DUST appears at the new Dust address on mainnet | Passed |

Transaction ids, addresses and dates of these runs are kept in a local `TEST-LOG.md`, which is not committed.

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

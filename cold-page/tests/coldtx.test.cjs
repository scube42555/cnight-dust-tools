// Tests for src/coldtx.js and the WASM module. Run: node --test cold-page/tests/   (after cold-page/build.sh)
// Uses only the public test mnemonic. Optional real-transaction check: COLD_TEST_SIGNED_TX=<cardano-cli signed tx file>.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const { ColdTx } = require(path.join(ROOT, 'src/coldtx.js'));
const fflate = require(path.join(ROOT, 'vendor/fflate-0.8.3.umd.js'));
const zlib = ColdTx.makeZlib(fflate);

function loadWasm() {
  const ctx = { console, TextEncoder, TextDecoder, WebAssembly, Uint8Array, Object, Error, FinalizationRegistry, crypto: nodeCrypto.webcrypto };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'wasm/pkg/dust_register_cold.js'), 'utf8') + ';this.wb = wasm_bindgen;', ctx);
  ctx.wb.initSync({ module: fs.readFileSync(path.join(ROOT, 'wasm/pkg/dust_register_cold_bg.wasm')) });
  return ctx.wb;
}
const W = loadWasm();
const cryptoFns = { blake2b: (h, n) => W.blake2b(h, n), bech32: (hrp, h) => W.bech32_encode(hrp, h) };

const MNEMONIC = 'abandon '.repeat(23) + 'art';
const KEYS = JSON.parse(W.cold_keys(MNEMONIC, '', 'mainnet', 0, 0));
const VALIDATOR = '73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5';
const EXPECT = { networkId: 1, validatorHash: VALIDATOR, stakeKeyHash: KEYS.stakeKeyHash, dustPublicKey: KEYS.dustPublicKey };

// ------------------------------------------------------------------ a tiny CBOR encoder for building test transactions
const hdr = (mt, n) => {
  n = BigInt(n);
  const m = mt << 5;
  if (n < 24n) return [m | Number(n)];
  for (const [ai, len] of [[24, 1], [25, 2], [26, 4], [27, 8]]) {
    if (n < 1n << BigInt(8 * len)) {
      const out = [m | ai];
      for (let i = len - 1; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 255n));
      return out;
    }
  }
  throw new Error('too big');
};
const U = (n) => hdr(0, n);
const N = (n) => hdr(1, -1n - BigInt(n));
const B = (hex) => [...hdr(2, hex.length / 2), ...Buffer.from(hex, 'hex')];
const A = (xs) => [...hdr(4, xs.length), ...xs.flat()];
const IA = (xs) => [0x9f, ...xs.flat(), 0xff]; // indefinite list, as cardano-cli writes Plutus data
const M = (kvs) => [...hdr(5, kvs.length), ...kvs.flat(2)];
const T = (tag, x) => [...hdr(6, tag), ...x];
const TRUE = [0xf5], NULL = [0xf6];
const bytes = (arr) => Uint8Array.from(arr);

const TXID = 'aa'.repeat(32);
const SPONSOR_PAY = 'bb'.repeat(28);
const SPONSOR_ADDR = '01' + SPONSOR_PAY + 'cc'.repeat(28);
const datum = (stake = KEYS.stakeKeyHash, dust = KEYS.dustPublicKey, credTag = 121) =>
  T(121, IA([T(credTag, IA([B(stake)])), B(dust)]));
const SCRIPT = JSON.parse(fs.readFileSync(path.join(ROOT, '../mapping_validator.plutus'), 'utf8')).cborHex;

/** A registration shaped like cardano-cli's output; `mod` changes parts of it. */
function buildTx(mod = {}) {
  const out0 = mod.out0 || M([
    [U(0), B(mod.out0Addr || '71' + VALIDATOR)],
    [U(1), A([U(2000000), M([[B(VALIDATOR), M([[B(mod.assetName || ''), mod.out0Amount || U(1)]])]])])],
    [U(2), A([U(1), T(24, B(Buffer.from(mod.datum || datum()).toString('hex')))])],
  ]);
  const change = M([[U(0), B(mod.changeAddr || SPONSOR_ADDR)], [U(1), U(95000000)]]);
  const body = [
    [U(0), T(258, A([A([B(TXID), U(1)])]))],
    [U(1), A([out0, change])],
    [U(2), U(450000)],
    [U(3), U(170000000)],
    [U(9), M([[B(mod.mintPolicy || VALIDATOR), M([[B(''), mod.mintAmount || U(1)]])]])],
    [U(11), B('dd'.repeat(32))],
    [U(13), T(258, A([A([B(TXID), U(0)])]))],
    [U(14), T(258, A([B(mod.signer || KEYS.stakeKeyHash)]))],
    ...(mod.extraBody || []),
  ];
  const redeemer = mod.redeemer || T(121, []).concat([0x80]); // Constr 0 [] (definite empty list)
  const wits = M([
    [U(5), M([[A([U(mod.redeemerTag ?? 1), U(0)]), A([redeemer, A([U(500000), U(200000000)])])]])],
    [U(7), A([B(SCRIPT)])],
  ]);
  return bytes(A([M(body), wits, TRUE, NULL]));
}
const errors = (r) => r.checks.filter((c) => c.level === 'error').map((c) => c.text);

// ------------------------------------------------------------------ tests

test('sha256 and base64url match Node', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 4097]) {
    const b = nodeCrypto.randomBytes(n);
    assert.equal(ColdTx.toHex(ColdTx.sha256(b)), nodeCrypto.createHash('sha256').update(b).digest('hex'));
    assert.equal(ColdTx.b64urlEncode(b), b.toString('base64url'));
    assert.deepEqual(Buffer.from(ColdTx.b64urlDecode(b.toString('base64url'))), b);
  }
});

test('MQR1 frames interoperate with midnight-cold-hot mqr.js in both directions', async () => {
  const mqr = await import(path.join(ROOT, '../../midnight-cold-hot/dist/mqr.js'));
  const payload = nodeCrypto.randomBytes(5000);
  const ours = ColdTx.encodeFrames('tx', payload, zlib, (n) => nodeCrypto.randomBytes(n));
  assert.deepEqual(Buffer.from(mqr.decodeMqrText(ours.frames.join('\n')).payload), payload);
  const theirs = mqr.encodeFrames('witness', payload);
  const back = ColdTx.decodeFrames([...theirs.frames].reverse().concat(theirs.frames[0]), zlib);
  assert.equal(back.kind, 'witness');
  assert.deepEqual(Buffer.from(back.payload), payload);
  for (const f of ours.frames) assert.ok(mqr.parseFrame(f), 'frame accepted by mqr.ts regex');
});

test('MQR1 decoding refuses damage, gaps, mixing and zip bombs', () => {
  const rnd = (n) => nodeCrypto.randomBytes(n);
  const { frames } = ColdTx.encodeFrames('tx', nodeCrypto.randomBytes(3000), zlib, rnd, 200);
  assert.throws(() => ColdTx.decodeFrames(frames.slice(1), zlib), /Missing frame/);
  const bad = frames.slice(); bad[1] = bad[1].slice(0, -2) + (bad[1].endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => ColdTx.decodeFrames(bad, zlib), /Checksum mismatch/);
  const other = ColdTx.encodeFrames('tx', nodeCrypto.randomBytes(100), zlib, rnd).frames;
  assert.throws(() => ColdTx.decodeFrames([...frames, ...other], zlib), /mixed/);
  assert.throws(() => ColdTx.decodeFrames(['MQR1:tx:zzzzzz:1:1:' + '0'.repeat(32) + ':AA'], zlib), /not a valid/);
  const bomb = ColdTx.encodeFrames('tx', new Uint8Array(5 * 1024 * 1024), zlib, rnd, 1000).frames;
  assert.throws(() => ColdTx.decodeFrames(bomb, zlib), /expands beyond/);
});

test('a well-formed registration passes every check', () => {
  const r = ColdTx.checkRegistration(buildTx(), EXPECT, cryptoFns);
  assert.deepEqual(errors(r), []);
  assert.equal(r.ok, true);
  assert.match(r.bodyHash, /^[0-9a-f]{64}$/);
  assert.equal(r.summary.outputs[0].address.text, 'addr1w9e7ft4rrdd4rkdseguxr9hudfxyytm5ckh2qy0yhz7lfeg9lvhq7');
  assert.equal(r.summary.inputs[0], TXID + '#1');
});

test('the body hash covers exactly the body bytes', () => {
  const tx = buildTx();
  const top = ColdTx.decodeCbor(tx);
  const body = tx.slice(top.items[0].s, top.items[0].e);
  assert.equal(ColdTx.checkRegistration(tx, EXPECT, cryptoFns).bodyHash, W.blake2b(Buffer.from(body).toString('hex'), 32));
});

const BAD = {
  'datum names another stake key': { datum: datum('ee'.repeat(28)) },
  'datum names another Dust key': { datum: datum(KEYS.stakeKeyHash, '02' + 'ee'.repeat(32)) },
  'datum credential is a script': { datum: datum(KEYS.stakeKeyHash, KEYS.dustPublicKey, 122) },
  'stake key not a required signer': { signer: 'ee'.repeat(28) },
  'certificates present': { extraBody: [[U(4), T(258, A([A([U(0), A([U(0), B(KEYS.stakeKeyHash)])])]))]] },
  'withdrawals present': { extraBody: [[U(5), M([[B('e1' + KEYS.stakeKeyHash), U(1000000)]])]] },
  'treasury donation present': { extraBody: [[U(22), U(1)]] },
  'unknown body field': { extraBody: [[U(99), U(1)]] },
  'burn instead of mint': { mintAmount: N(-1) },
  'mint of another policy': { mintPolicy: 'ee'.repeat(28) },
  'output 0 goes elsewhere': { out0Addr: '61' + SPONSOR_PAY },
  'output 0 has two tokens': { out0Amount: U(2) },
  'output 0 asset name not empty': { assetName: '41' },
  'redeemer is deregister': { redeemer: T(122, [0x80]) },
  'redeemer is for spending': { redeemerTag: 0 },
  'change on another network': { changeAddr: '00' + SPONSOR_PAY + 'cc'.repeat(28) },
};
for (const [name, mod] of Object.entries(BAD)) {
  test(`refuses: ${name}`, () => {
    const r = ColdTx.checkRegistration(buildTx(mod), EXPECT, cryptoFns);
    assert.equal(r.ok, false);
    assert.ok(errors(r).length > 0);
  });
}

test('refuses garbage and truncated input without throwing', () => {
  const tx = buildTx();
  for (const b of [tx.slice(0, tx.length - 5), bytes([0xff]), bytes([0x9f, 0x01]), bytes([0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), new Uint8Array(0)]) {
    const r = ColdTx.checkRegistration(b, EXPECT, cryptoFns);
    assert.equal(r.ok, false);
  }
  // nesting bomb
  const deep = bytes([...Array(100).fill(0x81), 0x00]);
  assert.equal(ColdTx.checkRegistration(deep, EXPECT, cryptoFns).ok, false);
});

test('reads cardano-cli envelopes and refuses other eras and witness files', () => {
  const hex = Buffer.from(buildTx()).toString('hex');
  assert.equal(ColdTx.readTxText(JSON.stringify({ type: 'Unwitnessed Tx ConwayEra', description: 'Ledger Cddl Format', cborHex: hex })).bytes.length, hex.length / 2);
  assert.equal(ColdTx.readTxText(hex).envelopeType, null);
  assert.throws(() => ColdTx.readTxText(JSON.stringify({ type: 'Unwitnessed Tx BabbageEra', cborHex: hex })), /Unexpected envelope/);
  assert.throws(() => ColdTx.readTxText(JSON.stringify({ type: 'TxWitness ConwayEra', cborHex: hex })), /Unexpected envelope/);
});

test('the witness file has the cardano-cli shape and a signature that verifies over the body hash', () => {
  const r = ColdTx.checkRegistration(buildTx(), EXPECT, cryptoFns);
  const s = JSON.parse(W.sign_with_stake_key(MNEMONIC, '', 0, 0, r.bodyHash));
  const env = JSON.parse(ColdTx.witnessEnvelope(s.vkey, s.signature));
  assert.equal(env.type, 'TxWitness ConwayEra');
  const w = ColdTx.decodeCbor(Buffer.from(env.cborHex, 'hex'));
  assert.equal(w.items[0].v, 0n);
  const [vk, sig] = w.items[1].items.map((x) => Buffer.from(x.v));
  assert.equal(vk.toString('hex'), KEYS.stakeVkey);
  const pub = nodeCrypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), vk]), format: 'der', type: 'spki' });
  assert.ok(nodeCrypto.verify(null, Buffer.from(r.bodyHash, 'hex'), pub, sig));
});

test('the datum JSON matches the datum the checks expect', () => {
  const j = JSON.parse(ColdTx.datumJson(KEYS.stakeKeyHash, KEYS.dustPublicKey));
  assert.equal(j.fields[0].fields[0].bytes, KEYS.stakeKeyHash);
  assert.equal(j.fields[1].bytes, KEYS.dustPublicKey);
});

test('real signed transaction: existing signatures verify against our body hash', { skip: !process.env.COLD_TEST_SIGNED_TX }, () => {
  const env = JSON.parse(fs.readFileSync(process.env.COLD_TEST_SIGNED_TX, 'utf8'));
  const tx = Buffer.from(env.cborHex, 'hex');
  const top = ColdTx.decodeCbor(tx);
  const bodyHash = W.blake2b(tx.subarray(top.items[0].s, top.items[0].e).toString('hex'), 32);
  const wits = top.items[1].entries.find(([k]) => k.v === 0n)[1];
  const list = wits.t === 'tag' ? wits.item.items : wits.items;
  assert.ok(list.length > 0);
  for (const w of list) {
    const [vk, sig] = w.items.map((x) => Buffer.from(x.v));
    const pub = nodeCrypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), vk]), format: 'der', type: 'spki' });
    assert.ok(nodeCrypto.verify(null, Buffer.from(bodyHash, 'hex'), pub, sig), 'witness verifies');
  }
  // It is not a registration, so the checks must refuse it.
  assert.equal(ColdTx.checkRegistration(tx, EXPECT, cryptoFns).ok, false);
});

// COLD_WRITE_FIXTURE=<dir> writes a test-vector registration (abandon … art, mainnet) for trying the page by hand.
if (process.env.COLD_WRITE_FIXTURE) {
  const env = { type: 'Unwitnessed Tx ConwayEra', description: 'Ledger Cddl Format', cborHex: Buffer.from(buildTx()).toString('hex') };
  fs.writeFileSync(path.join(process.env.COLD_WRITE_FIXTURE, 'testvector-register.unsigned'), JSON.stringify(env, null, 4) + '\n');
}

test('QR codes drawn the way the page draws them are read back by jsQR', () => {
  const qrcode = require(path.join(ROOT, 'vendor/qrcode-generator-1.4.4.js'));
  const jsQR = require(path.join(ROOT, 'vendor/jsQR-1.4.0.js'));
  const r = ColdTx.checkRegistration(buildTx(), EXPECT, cryptoFns);
  const s = JSON.parse(W.sign_with_stake_key(MNEMONIC, '', 0, 0, r.bodyHash));
  const payload = new TextEncoder().encode(ColdTx.witnessEnvelope(s.vkey, s.signature));
  const { frames } = ColdTx.encodeFrames('witness', payload, zlib, (n) => nodeCrypto.randomBytes(n), 500);
  assert.equal(frames.length, 1, 'a witness fits in one QR code');
  for (const f of frames) {
    const qr = qrcode(0, 'M'); qr.addData(f, 'Byte'); qr.make();
    const n = qr.getModuleCount(), q = 4, scale = 4, size = (n + 2 * q) * scale;
    const px = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const r0 = Math.floor(y / scale) - q, c0 = Math.floor(x / scale) - q;
      if (r0 >= 0 && c0 >= 0 && r0 < n && c0 < n && qr.isDark(r0, c0)) px.fill(0, (y * size + x) * 4, (y * size + x) * 4 + 3);
    }
    assert.equal(jsQR(px, size, size).data, f);
  }
});

// ------------------------------------------------------------------ cNIGHT self-send

const PAY = JSON.parse(W.payment_key(MNEMONIC, '', 0, 0));
const CNIGHT = '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa';
const SS_EXPECT = { networkId: 1, paymentKeyHash: PAY.paymentKeyHash, stakeKeyHash: KEYS.stakeKeyHash, cnightPolicy: CNIGHT };
const OWN = '01' + PAY.paymentKeyHash + KEYS.stakeKeyHash;

/** A self-send shaped like cardano-cli's `transaction build` with only a change address; `mod` changes parts of it. */
function buildSelfSend(mod = {}) {
  const tokens = M([[B(mod.policy || CNIGHT), M([[B('4e49474854'), U(1000000)]])]]);
  const outs = mod.outs || [M([[U(0), B(mod.addr || OWN)], [U(1), A([U(1800000), tokens])], ...(mod.outExtra || [])])];
  const body = [
    [U(0), T(258, A([A([B(TXID), U(0)]), A([B('ab'.repeat(32)), U(2)])]))],
    [U(1), A(outs)],
    [U(2), mod.fee || U(171000)],
    [U(3), U(170000000)],
    ...(mod.extraBody || []),
  ];
  return bytes(A([M(body), mod.wits || M([]), TRUE, NULL]));
}

test('a self-send back to your own address passes', () => {
  const r = ColdTx.checkSelfSend(buildSelfSend(), SS_EXPECT, cryptoFns);
  assert.deepEqual(errors(r), []);
  assert.equal(r.ok, true);
  assert.equal(r.summary.cnight, 1000000n);
  assert.equal(r.summary.ownAddress, KEYS.baseAddress);
});

test('the transaction type is told apart, and each kind fails the other kind\'s checks', () => {
  assert.equal(ColdTx.txKind(buildTx()), 'register');
  assert.equal(ColdTx.txKind(buildSelfSend()), 'selfsend');
  assert.equal(ColdTx.txKind(bytes([0xff])), 'register');
  assert.equal(ColdTx.checkSelfSend(buildTx(), SS_EXPECT, cryptoFns).ok, false);
  assert.equal(ColdTx.checkRegistration(buildSelfSend(), EXPECT, cryptoFns).ok, false);
});

const OTHER_PAY = 'ee'.repeat(28);
const SS_BAD = {
  'output to someone else': { addr: '01' + OTHER_PAY + 'cc'.repeat(28) },
  'output with your stake key but another payment key': { addr: '01' + OTHER_PAY + KEYS.stakeKeyHash },
  'output to your payment key as an enterprise address': { addr: '61' + PAY.paymentKeyHash },
  'output on another network': { addr: '00' + PAY.paymentKeyHash + KEYS.stakeKeyHash },
  'second output to someone else': { outs: [
    M([[U(0), B(OWN)], [U(1), A([U(1800000), M([[B(CNIGHT), M([[B(''), U(5)]])]])])]]),
    M([[U(0), B('61' + OTHER_PAY)], [U(1), U(50000000)]]),
  ] },
  'no cNIGHT in the outputs': { policy: 'ee'.repeat(28) },
  'fee too high': { fee: U(3000000) },
  'mint present': { extraBody: [[U(9), M([[B(OTHER_PAY), M([[B(''), U(1)]])]])]] },
  'script data hash present': { extraBody: [[U(11), B('dd'.repeat(32))]] },
  'collateral present': { extraBody: [[U(13), T(258, A([A([B(TXID), U(3)])]))]] },
  'reference inputs present': { extraBody: [[U(18), T(258, A([A([B(TXID), U(4)])]))]] },
  'certificates present': { extraBody: [[U(4), T(258, A([A([U(0), A([U(0), B(KEYS.stakeKeyHash)])])]))]] },
  'withdrawals present': { extraBody: [[U(5), M([[B('e1' + KEYS.stakeKeyHash), U(1000000)]])]] },
  'unknown body field': { extraBody: [[U(99), U(1)]] },
  'another required signer': { extraBody: [[U(14), T(258, A([B(OTHER_PAY)]))]] },
  'network id mismatch': { extraBody: [[U(15), U(0)]] },
  'datum on the output': { outExtra: [[U(2), A([U(0), B('dd'.repeat(32))])]] },
  'redeemer in the witness set': { wits: M([[U(5), M([[A([U(0), U(0)]), A([T(121, [0x80]), A([U(1), U(1)])])]])]]) },
  'native script in the witness set': { wits: M([[U(1), A([A([U(0), B(OTHER_PAY)])])]]) },
};
for (const [name, mod] of Object.entries(SS_BAD)) {
  test(`self-send refuses: ${name}`, () => {
    const r = ColdTx.checkSelfSend(buildSelfSend(mod), SS_EXPECT, cryptoFns);
    assert.equal(r.ok, false);
    assert.ok(errors(r).length > 0);
  });
}

test('the payment-key witness verifies over the self-send body hash', () => {
  const r = ColdTx.checkSelfSend(buildSelfSend(), SS_EXPECT, cryptoFns);
  const s = JSON.parse(W.sign_with_payment_key(MNEMONIC, '', 0, 0, r.bodyHash));
  assert.equal(s.vkey, PAY.paymentVkey);
  assert.equal(W.blake2b(s.vkey, 28), PAY.paymentKeyHash);
  const pub = nodeCrypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(s.vkey, 'hex')]), format: 'der', type: 'spki' });
  assert.ok(nodeCrypto.verify(null, Buffer.from(r.bodyHash, 'hex'), pub, Buffer.from(s.signature, 'hex')));
  assert.notEqual(s.vkey, KEYS.stakeVkey);
});

if (process.env.COLD_WRITE_FIXTURE) {
  const env = { type: 'Unwitnessed Tx ConwayEra', description: 'Ledger Cddl Format', cborHex: Buffer.from(buildSelfSend()).toString('hex') };
  fs.writeFileSync(path.join(process.env.COLD_WRITE_FIXTURE, 'testvector-move-cnight.unsigned'), JSON.stringify(env, null, 4) + '\n');
}

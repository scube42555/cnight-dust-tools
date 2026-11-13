// Page controller. Everything that arrives from outside (files, pasted text, camera) is shown with textContent only.
(function () {
  'use strict';
  const C = window.ColdTx;
  const $ = (id) => document.getElementById(id);
  const zlib = C.makeZlib(window.fflate);
  const random = (n) => crypto.getRandomValues(new Uint8Array(n));
  // The wasm-bindgen glue declares `let wasm_bindgen` at the top level: a global binding, not a window property.
  const W = wasm_bindgen; // eslint-disable-line no-undef

  // Mainnet mapping validator: blake2b-224(0x03 || cborHex bytes) of mapping_validator.plutus in this repository.
  const MAINNET_VALIDATOR = '73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5';
  // Preprod: the validator of midnight-node scripts/cnight-generates-dust (commit 059a9e2). On 12 Nov 2026 its preprod
  // address held 57 registration UTxOs, so it is the one in use there.
  const PREPROD_VALIDATOR = '7e69087d98fac5869eac14e13dfb6f98228c41e638aa2a59d1f85e9c';
  // Mainnet cNIGHT policy: the one the mainnet mapping validator itself names (its script bytes contain this hash next
  // to the word "mainnet"). Preprod: the test cNIGHT policy used with the preprod validator.
  const MAINNET_CNIGHT = '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa';
  const PREPROD_CNIGHT = 'd2dbff622e509dda256fedbd31ef6e9fd98ed49ad91d5c0e07f68af1';

  let keys = null;      // public data from cold_keys, plus the settings used
  let checked = null;   // {result, bytes} of the last transaction that passed every check
  let qrTimers = [];

  const show = (el, on) => { el.hidden = !on; };
  const setErr = (id, msg) => { $(id).textContent = msg || ''; show($(id), !!msg); };
  const unlock = (id, on) => $(id).classList.toggle('locked', !on);

  if (navigator.onLine) show($('online'), true);
  window.addEventListener('online', () => show($('online'), true));

  // ---------------------------------------------------------------- WASM

  const wasmBytes = Uint8Array.from(atob(window.COLD_WASM_B64), (c) => c.charCodeAt(0));
  W({ module_or_path: wasmBytes }).then(() => {
    $('loading').hidden = true;
    $('derive').disabled = false;
  }).catch((e) => {
    $('loading').hidden = true;
    $('fatal').textContent = `The key module could not start: ${e && e.message ? e.message : e}`;
    $('fatal').hidden = false;
  });
  const cryptoFns = { blake2b: (h, n) => W.blake2b(h, n), bech32: (hrp, h) => W.bech32_encode(hrp, h) };

  // ---------------------------------------------------------------- QR display

  function svgOf(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const q = 4;
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
    const size = n + 2 * q;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
      `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  /** Show MQR1 frames for `payload` (text) as a cycling QR code inside `box`. */
  function showQr(box, kind, payloadText, label) {
    stopQr(box);
    // 500 characters per frame keeps a datum or a witness in one QR code (about version 13, still easy to scan).
    const { frames, session } = C.encodeFrames(kind, new TextEncoder().encode(payloadText), zlib, random, 500);
    const svgs = frames.map(svgOf); // our own data only, safe for innerHTML
    box.replaceChildren();
    const wrap = document.createElement('div'); wrap.className = 'qrbox';
    const qr = document.createElement('div'); qr.className = 'qr';
    const meta = document.createElement('div'); meta.className = 'qrmeta';
    const status = document.createElement('p');
    const desc = document.createElement('p');
    desc.textContent = `${label} — MQR1 kind "${kind}", session ${session}. Receive it on the hot machine with receiver.html or qr_scan.py from midnight-cold-hot, then decode with qr-decode.js.`;
    const raw = document.createElement('pre'); raw.textContent = frames.join('\n');
    const rawLabel = document.createElement('p'); rawLabel.textContent = 'Frames as text:';
    meta.append(status, desc, rawLabel, raw);
    wrap.append(qr, meta);
    box.append(wrap);
    let i = 0;
    const draw = () => { qr.innerHTML = svgs[i]; status.textContent = `Frame ${i + 1} of ${frames.length}`; };
    draw();
    if (frames.length > 1) {
      const t = setInterval(() => { i = (i + 1) % frames.length; draw(); }, 700);
      qrTimers.push({ box, t });
    }
  }
  function stopQr(box) {
    qrTimers = qrTimers.filter((x) => { if (box && x.box !== box) return true; clearInterval(x.t); return false; });
    if (box) box.replaceChildren();
  }

  function downloadLink(a, text) {
    if (a.href && a.href.startsWith('blob:')) URL.revokeObjectURL(a.href);
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.hidden = false;
  }

  // ---------------------------------------------------------------- step 1: keys

  $('network').addEventListener('change', () => {
    const net = $('network').value;
    show($('validatorRow'), net !== 'mainnet');
    if (net === 'preprod') { $('validator').value = PREPROD_VALIDATOR; $('cnight').value = PREPROD_CNIGHT; }
    resetFrom(1);
  });
  for (const id of ['phrase', 'pass', 'account', 'index', 'payIndex', 'validator', 'cnight']) $(id).addEventListener('input', () => resetFrom(1));

  $('plutusBtn').addEventListener('click', () => $('plutusFile').click());
  $('plutusFile').addEventListener('change', async () => {
    const f = $('plutusFile').files[0];
    $('plutusFile').value = '';
    if (!f) return;
    try {
      if (f.size > 100000) throw new Error('The file is too large to be a validator.');
      let text = await f.text();
      // Also accept the .plutus file sent as QR codes (MQR1 frames saved by qr_scan.py or receiver.html).
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length && lines.every((l) => l.startsWith('MQR1:'))) {
        text = new TextDecoder('utf-8', { fatal: true }).decode(C.decodeFrames(lines, zlib, 100000).payload);
      }
      const j = JSON.parse(text);
      if (j.type !== 'PlutusScriptV3' || typeof j.cborHex !== 'string') throw new Error('Expected a PlutusScriptV3 text envelope.');
      $('validator').value = W.blake2b('03' + C.toHex(C.fromHex(j.cborHex)), 28);
      resetFrom(1);
    } catch (e) { setErr('keysErr', `Could not read the .plutus file: ${e.message}`); }
  });

  function pathNumber(id) {
    const v = $(id).value.trim();
    const name = { account: 'Account', index: 'Stake key index', payIndex: 'Address index' }[id];
    if (!/^\d{1,10}$/.test(v) || Number(v) >= 2 ** 31) throw new Error(`${name} must be a whole number below 2147483648.`);
    return Number(v);
  }

  $('derive').addEventListener('click', () => {
    resetFrom(1);
    setErr('keysErr', '');
    try {
      const network = $('network').value;
      const account = pathNumber('account');
      const index = pathNumber('index');
      const payIndex = pathNumber('payIndex');
      let validatorHash = MAINNET_VALIDATOR, cnightPolicy = MAINNET_CNIGHT;
      if (network !== 'mainnet') {
        validatorHash = $('validator').value.trim().toLowerCase();
        if (!/^[0-9a-f]{56}$/.test(validatorHash)) throw new Error('Enter the mapping validator hash for this network (56 hex characters), or load its .plutus file.');
        cnightPolicy = $('cnight').value.trim().toLowerCase();
        if (!/^[0-9a-f]{56}$/.test(cnightPolicy)) throw new Error('Enter the cNIGHT policy id for this network (56 hex characters).');
      }
      const k = JSON.parse(W.cold_keys($('phrase').value, $('pass').value, network, account, index));
      const p = JSON.parse(W.payment_key($('phrase').value, $('pass').value, account, payIndex));
      const networkId = network === 'mainnet' ? 1 : 0;
      keys = Object.assign(k, p, { network, account, index, payIndex, validatorHash, cnightPolicy, networkId });
      keys.ownAddress = W.bech32_encode(networkId ? 'addr' : 'addr_test', C.baseAddressHex(networkId, keys.paymentKeyHash, keys.stakeKeyHash));
    } catch (e) {
      setErr('keysErr', e.message || String(e));
      return;
    }
    $('kBase').textContent = `${keys.ownAddress}   payment ${keys.paymentPath}, stake ${keys.stakePath}`;
    $('kStake').textContent = `${keys.stakeAddress}   ${keys.stakePath}`;
    $('kHash').textContent = keys.stakeKeyHash;
    $('kDust').textContent = `${keys.dustAddress}   ${keys.dustPath}`;
    $('kDustPk').textContent = `${keys.dustPublicKey} (${keys.dustPublicKey.length / 2} bytes)`;
    $('kValidator').textContent = `${W.bech32_encode(keys.networkId ? 'addr' : 'addr_test', (keys.networkId ? '71' : '70') + keys.validatorHash)}  (hash ${keys.validatorHash})`;
    $('kCnight').textContent = keys.cnightPolicy;
    show($('keysOut'), true);

    const datum = C.datumJson(keys.stakeKeyHash, keys.dustPublicKey);
    $('datum').textContent = datum;
    downloadLink($('datumDl'), datum);
    $('datumQr').disabled = false;
    $('ownAddr').textContent = keys.ownAddress;
    downloadLink($('addrDl'), keys.ownAddress + '\n');
    $('addrQr').disabled = false;
    unlock('s2', true);
    unlock('s3', true);
    $('txFileBtn').disabled = false;
    $('camBtn').disabled = false;
    $('check').disabled = false;
  });

  $('datumQr').addEventListener('click', () => {
    try { showQr($('datumQrBox'), 'datum', $('datum').textContent, 'datum.json'); } catch (e) { setErr('keysErr', e.message); }
  });

  $('addrQr').addEventListener('click', () => {
    try { showQr($('addrQrBox'), 'addr', keys.ownAddress + '\n', 'cold.addr'); } catch (e) { setErr('keysErr', e.message); }
  });

  /** Forget everything derived from step `n` on (1 = keys and after). */
  function resetFrom(n) {
    if (n <= 1) {
      keys = null;
      show($('keysOut'), false);
      $('datum').textContent = '';
      $('datumDl').hidden = true;
      $('datumQr').disabled = true;
      stopQr($('datumQrBox'));
      $('ownAddr').textContent = '';
      $('addrDl').hidden = true;
      $('addrQr').disabled = true;
      stopQr($('addrQrBox'));
      unlock('s2', false); unlock('s3', false);
      $('txFileBtn').disabled = true; $('camBtn').disabled = true; $('check').disabled = true;
      stopCamera();
    }
    checked = null;
    unlock('s4', false); unlock('s5', false);
    $('checks').replaceChildren(); $('summary').replaceChildren(); $('verdict').replaceChildren();
    $('bodyHash').textContent = '—';
    $('signTitle').textContent = 'Sign';
    $('confirm').value = '';
    $('sign').disabled = true;
    show($('witnessOut'), false);
    $('witness').textContent = '';
    stopQr($('witnessQrBox'));
    setErr('signErr', '');
  }

  $('clear').addEventListener('click', () => {
    for (const id of ['phrase', 'pass', 'txText', 'validator', 'confirm']) $(id).value = '';
    $('account').value = '0'; $('index').value = '0'; $('payIndex').value = '0';
    setErr('keysErr', ''); setErr('txErr', '');
    resetFrom(1);
  });

  // ---------------------------------------------------------------- step 3: receive

  $('txFileBtn').addEventListener('click', () => $('txFile').click());
  $('txFile').addEventListener('change', async () => {
    const f = $('txFile').files[0];
    $('txFile').value = '';
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) { setErr('txErr', 'The file is too large (over 4 MB).'); return; }
    $('txText').value = await f.text();
    runCheck();
  });
  $('txText').addEventListener('input', () => resetFrom(3));
  $('check').addEventListener('click', runCheck);

  /** Text from any source -> transaction bytes. MQR1 frames are joined and decompressed first. */
  function txBytesFrom(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let note = '';
    if (lines.length && lines.every((l) => l.startsWith('MQR1:'))) {
      const d = C.decodeFrames(lines, zlib);
      if (d.kind !== 'tx') throw new Error(`These frames carry "${d.kind}", not a transaction ("tx").`);
      note = `Joined ${d.total} MQR1 frame(s), session ${d.session}; checksum OK.`;
      text = new TextDecoder('utf-8', { fatal: true }).decode(d.payload);
    }
    const r = C.readTxText(text);
    return { bytes: r.bytes, note: [note, r.envelopeType ? `cardano-cli file of type "${r.envelopeType}".` : 'Bare CBOR hex.'].filter(Boolean).join(' ') };
  }

  function runCheck() {
    resetFrom(3);
    setErr('txErr', '');
    if (!keys) { setErr('txErr', 'Derive your keys in step 1 first.'); return; }
    let input;
    try { input = txBytesFrom($('txText').value); } catch (e) { setErr('txErr', e.message); return; }
    const kind = C.txKind(input.bytes);
    const result = runChecks(kind, input.bytes);
    renderReview(kind, result, input.note);
    unlock('s4', true);
    $('signTitle').textContent = kind === 'register' ? 'Sign the registration with the stake key' : 'Sign the cNIGHT move with the payment key';
    if (result.ok) {
      checked = { kind, result, bytes: input.bytes };
      unlock('s5', true);
      $('bodyHash').textContent = result.bodyHash;
      $('sign').disabled = false;
    }
  }

  /** A transaction that mints is checked as a registration; anything else as a self-send. Each set of checks is complete on its own. */
  function runChecks(kind, bytes) {
    return kind === 'register' ? C.checkRegistration(bytes, keys, cryptoFns) : C.checkSelfSend(bytes, keys, cryptoFns);
  }

  function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }

  function renderReview(kind, r, note) {
    const reg = kind === 'register';
    const v = $('verdict');
    v.replaceChildren(el('p', reg ? 'Type: DUST registration (it mints a token), checked with the registration rules.'
      : 'Type: cNIGHT self-send (it mints nothing), checked with the self-send rules.', 'qrmeta'));
    v.append(r.ok
      ? el('div', reg ? 'Every check passed. This is a DUST registration for your stake key and Dust key. Review the details, then sign below.'
        : 'Every check passed. This moves your cNIGHT back to your own address, which starts DUST generation if the registration is on chain. Review the details, then sign below.', 'banner ok')
      : el('div', 'Do not sign. The transaction failed one or more checks (marked ✗).', 'banner err'));
    if (note) v.append(el('p', note, 'qrmeta'));
    const order = { error: 0, warn: 1, ok: 2, info: 3 };
    const list = $('checks');
    for (const c of r.checks.slice().sort((a, b) => order[a.level] - order[b.level])) list.append(el('li', c.text, c.level));

    const s = r.summary;
    const box = $('summary');
    const kv = el('dl', undefined, 'kv');
    const add = (k, val) => { kv.append(el('dt', k), el('dd', val)); };
    if (s.fee !== undefined) add(reg ? 'Fee (paid by sponsor)' : 'Fee (paid from the inputs)', C.lovelaceText(s.fee));
    if (!reg && s.cnight !== undefined) add('cNIGHT moved', `${s.cnight} unit(s)`);
    if (s.ttl !== undefined) add('Valid until slot', s.ttl.toString());
    if (s.validFrom !== undefined) add('Valid from slot', s.validFrom.toString());
    if (s.mint.length) add('Mint', s.mint.map((m) => `${m.amount} × ${m.policy}${m.name ? '.' + m.name : ''}`).join('\n'));
    add('Required signers', s.requiredSigners.map((h) => h + (keys && h === keys.stakeKeyHash ? '  (your stake key)' : keys && h === keys.paymentKeyHash ? '  (your payment key)' : '')).join('\n') || '—');
    if (reg) {
      add('Inputs (sponsor)', s.inputs.join('\n') || '—');
      add('Collateral (sponsor)', s.collateral.join('\n') || '—');
    } else {
      add('Inputs (yours, and maybe a sponsor gift)', s.inputs.join('\n') || '—');
    }
    if (s.totalCollateral !== undefined) add('Total collateral', C.lovelaceText(s.totalCollateral));
    if (s.collateralReturn) add('Collateral return', `${s.collateralReturn.address.text}  ${C.lovelaceText(s.collateralReturn.value.lovelace)}`);
    if (s.referenceInputs.length) add('Reference inputs', s.referenceInputs.join('\n'));
    if (s.existingWitnesses) add('Signatures present', s.existingWitnesses.join('\n'));
    for (const dd of kv.querySelectorAll('dd')) dd.style.whiteSpace = 'pre-wrap';
    box.replaceChildren(el('h3', 'Details'), kv);

    if (s.outputs.length) {
      const t = el('table');
      const head = el('tr');
      for (const h of ['#', 'Address', 'ADA', 'Tokens', 'Datum']) head.append(el('th', h));
      t.append(head);
      s.outputs.forEach((o, i) => {
        const tr = el('tr');
        const addr = el('td', o.address.text, 'mono');
        if (reg && i === 0) addr.append(document.createElement('br'), el('span', 'mapping validator', 'tag'));
        if (!reg && o.own) addr.append(document.createElement('br'), el('span', 'your address', 'tag you'));
        tr.append(el('td', String(i)), addr, el('td', C.lovelaceText(o.value.lovelace).replace(' ADA', '')),
          el('td', o.value.assets.map((a) => `${a.amount} × ${a.policy.slice(0, 12)}…${a.name ? '.' + a.name : ''}`).join('\n') || '—', 'mono'),
          el('td', o.datum ? 'inline' : o.datumHash ? 'hash' : '—'));
        t.append(tr);
      });
      const wrap = el('div', undefined, 'tablewrap');
      wrap.append(t);
      box.append(el('h3', 'Outputs'), wrap);
    }
    box.append(el('p', reg ? 'This page cannot see what the inputs hold (that needs the chain). They belong to the sponsor; your keys only sign as the stake key.'
      : 'This page cannot see what the inputs hold (that needs the chain). Every output comes back to your address, so the most you can lose is the fee shown above.', 'qrmeta'));
  }

  // ---------------------------------------------------------------- camera (optional)

  let stream = null, scanTimer = null, collect = null;
  $('camBtn').addEventListener('click', startCamera);
  $('camStop').addEventListener('click', stopCamera);

  async function startCamera() {
    setErr('txErr', '');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setErr('txErr', 'This browser cannot use a camera here. Use qr_scan.py and load the .mqr file instead.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) {
      setErr('txErr', `The camera could not start (${e.name || e.message}). Use qr_scan.py and load the .mqr file instead.`);
      return;
    }
    collect = null;
    const video = $('video');
    video.srcObject = stream;
    await video.play();
    show($('camBox'), true); show($('camStop'), true); $('camBtn').hidden = true;
    $('camStatus').textContent = 'Scanning… point the camera at the hot machine\'s QR codes.';
    const canvas = $('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    scanTimer = setInterval(() => {
      if (video.readyState < 2) return;
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return;
      canvas.width = w; canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      if (code && code.data) acceptFrame(code.data);
    }, 150);
  }

  function acceptFrame(text) {
    const f = C.parseFrame(text);
    if (!f) return;
    if (!collect) collect = { session: f.session, kind: f.kind, total: f.total, hash: f.hash, frames: new Map() };
    if (f.session !== collect.session || f.total !== collect.total || f.hash !== collect.hash) return; // locked on the first transfer
    collect.frames.set(f.index, text.trim());
    $('camStatus').textContent = `Transfer ${collect.session} (${collect.kind}): ${collect.frames.size} of ${collect.total} frames.`;
    if (collect.frames.size === collect.total) {
      const lines = [];
      for (let i = 1; i <= collect.total; i++) lines.push(collect.frames.get(i));
      stopCamera();
      $('txText').value = lines.join('\n') + '\n';
      runCheck();
    }
  }

  function stopCamera() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    show($('camBox'), false); show($('camStop'), false); $('camBtn').hidden = false;
  }

  // ---------------------------------------------------------------- step 5: sign

  $('confirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('sign').click(); });
  $('sign').addEventListener('click', () => {
    setErr('signErr', '');
    if (!checked || !keys) { setErr('signErr', 'Check a transaction first.'); return; }
    if ($('confirm').value.trim() !== 'SIGN') { setErr('signErr', 'Type SIGN (capital letters) to confirm.'); return; }
    // Re-run the checks on the exact bytes being signed, with the keys as they are now.
    const reg = checked.kind === 'register';
    if (C.txKind(checked.bytes) !== checked.kind) { setErr('signErr', 'The checks no longer pass; check the transaction again.'); return; }
    const again = runChecks(checked.kind, checked.bytes);
    if (!again.ok || again.bodyHash !== checked.result.bodyHash) { setErr('signErr', 'The checks no longer pass; check the transaction again.'); return; }
    let w;
    try {
      const phrase = $('phrase').value, pass = $('pass').value;
      const s = JSON.parse(reg
        ? W.sign_with_stake_key(phrase, pass, keys.account, keys.index, again.bodyHash)
        : W.sign_with_payment_key(phrase, pass, keys.account, keys.payIndex, again.bodyHash));
      if (s.vkey !== (reg ? keys.stakeVkey : keys.paymentVkey)) throw new Error('The signing key does not match the derived key. Derive the keys again.');
      w = C.witnessEnvelope(s.vkey, s.signature);
    } catch (e) { setErr('signErr', e.message || String(e)); return; }
    const file = reg ? 'cold-stake.witness' : 'cold-payment.witness';
    $('confirm').value = '';
    $('witness').textContent = w;
    $('witnessNext').textContent = reg
      ? 'Take this witness to the hot machine. hot/assemble-submit.sh adds the sponsor\'s signature and submits.'
      : 'Take this witness to the hot machine. hot/submit-move-cnight.sh adds the sponsor\'s signature (if it gave an input) and submits.';
    $('witnessDl').download = file;
    $('witnessDl').textContent = `Download ${file}`;
    downloadLink($('witnessDl'), w);
    show($('witnessOut'), true);
    try { showQr($('witnessQrBox'), 'witness', w, file); } catch (e) { setErr('signErr', e.message); }
  });
})();

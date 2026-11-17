// Hot page controller. Talks only to hot/hot-server.py on this machine (CSP connect-src 'self').
// Everything that arrives from the cold side (camera, files, paste) is shown with textContent only, and checked again
// by the server and by the scripts before it is used.
(function () {
  'use strict';
  const C = window.ColdTx;
  const $ = (id) => document.getElementById(id);
  const zlib = C.makeZlib(window.fflate);
  const random = (n) => crypto.getRandomValues(new Uint8Array(n));
  const W = wasm_bindgen; // eslint-disable-line no-undef
  // The token arrives after the # in the URL the server printed. It is kept for this tab only, so a reload works.
  const TOKEN = (() => {
    const h = location.hash.slice(1);
    try { if (h) sessionStorage.setItem('hotToken', h); return h || sessionStorage.getItem('hotToken') || ''; } catch (_) { return h; }
  })();
  let state = null;
  let qrTimers = [];

  const el = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  const show = (e, on) => { e.hidden = !on; };
  const unlock = (id, on) => $(id).classList.toggle('locked', !on);
  const fatal = (msg) => { $('fatal').textContent = msg; show($('fatal'), true); };

  async function api(name, body) {
    const r = await fetch(`/api/${name}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hot-Token': TOKEN },
      body: JSON.stringify(body || {}), cache: 'no-store',
    });
    let j;
    try { j = await r.json(); } catch (_) { throw new Error(`The server answered ${r.status} without JSON.`); }
    if (!r.ok) throw new Error(j.error || `The server answered ${r.status}.`);
    return j;
  }

  // ---------------------------------------------------------------- QR display (same drawing as the cold page)

  function svgOf(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();
    const n = qr.getModuleCount(), q = 4;
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
    const size = n + 2 * q;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
      `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }
  function stopQr(box) {
    qrTimers = qrTimers.filter((x) => { if (box && x.box !== box) return true; clearInterval(x.t); return false; });
  }
  function showQr(box, kind, payloadText, label) {
    stopQr(box);
    // 300 characters per frame: easy to scan from a screen, about 13 frames for a registration.
    const { frames, session } = C.encodeFrames(kind, new TextEncoder().encode(payloadText), zlib, random, 300);
    const svgs = frames.map(svgOf); // our own data only, safe for innerHTML
    const wrap = el('div', undefined, 'qrbox');
    const qr = el('div', undefined, 'qr');
    const meta = el('div', undefined, 'qrmeta');
    const status = el('p');
    const speed = el('p');
    let ms = 700;
    const slower = el('button', 'Slower', 'secondary'), faster = el('button', 'Faster', 'secondary');
    slower.type = faster.type = 'button';
    meta.append(status, el('p', `${label}: MQR1 kind "${kind}", session ${session}. Load it in the cold page's step 3: its camera, or qr_scan.py.`),
      speed, slower, document.createTextNode(' '), faster, el('p', 'Frames as text:'), el('pre', frames.join('\n')));
    wrap.append(qr, meta);
    box.replaceChildren(wrap);
    let i = 0;
    const draw = () => { qr.innerHTML = svgs[i]; status.textContent = `Frame ${i + 1} of ${frames.length}`; speed.textContent = `${ms} ms per frame`; };
    const start = () => {
      stopQr(box);
      if (frames.length > 1) qrTimers.push({ box, t: setInterval(() => { i = (i + 1) % frames.length; draw(); }, ms) });
      draw();
    };
    slower.onclick = () => { ms = Math.min(3000, ms + 200); start(); };
    faster.onclick = () => { ms = Math.max(200, ms - 200); start(); };
    start();
  }
  function downloadLink(name, text) {
    const a = el('a', `Download ${name}`, 'btn secondary');
    a.download = name;
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    return a;
  }

  // ---------------------------------------------------------------- status

  async function refresh() {
    try { state = await api('state'); } catch (e) { fatal(e.message); return; }
    $('fatal').hidden = true;
    const net = $('net');
    net.textContent = state.network === 'mainnet' ? 'MAINNET' : state.network;
    net.className = 'net ' + state.network;
    const t = state.tip || {};
    $('tip').textContent = t.error ? `not reachable: ${t.error}` : `slot ${t.slot}, epoch ${t.epoch}, synced ${t.syncProgress}%`;
    $('dir').textContent = state.dir;
    $('validator').textContent = `${state.validatorAddress}\n(hash ${state.validatorHash})`;
    const s = state.sponsor;
    const warns = [];
    if (!s) {
      $('sponsor').textContent = 'no payment.addr in the folder';
      warns.push('Put the sponsor\'s payment.addr and payment.skey in the folder (hot/make-sponsor-keys.sh).');
    } else if (s.error) {
      $('sponsor').textContent = `${s.address}\n${s.error}`;
    } else {
      const ada = (l) => C.lovelaceText(BigInt(l));
      $('sponsor').textContent = `${s.address}\n${ada(s.lovelace)} in ${s.utxos} UTxO(s); ADA-only: ${s.adaOnly.map(ada).join(', ') || 'none'}`;
      const big = s.adaOnly.filter((l) => l >= 3e6).length, two = s.adaOnly.filter((l) => l >= 2e6).length;
      if (big < 1 || two < 2) warns.push('For a registration the sponsor needs two ADA-only UTxOs: one of at least 3 ADA and another of at least 2 ADA (for a deregistration, two of at least 2 ADA).');
    }
    if (!state.files['payment.skey']) warns.push('There is no payment.skey in the folder; the sponsor cannot sign.');
    if (!t.error && Number(t.syncProgress) < 100) warns.push(`The node is at ${t.syncProgress}% sync. Wait for 100% before building: the sponsor's UTxOs may be out of date.`);
    $('statusWarn').textContent = warns.join(' ');
    show($('statusWarn'), warns.length > 0);
    if (state.datum && !flows.register.datum) acceptDatum(state.datum, true);
    if (state.coldAddr && !flows.selfsend.addr) acceptAddr(state.coldAddr, true);
  }
  $('refresh').addEventListener('click', refresh);

  // ---------------------------------------------------------------- tabs

  const TABS = { tabReg: 'flowReg', tabMove: 'flowMove', tabDereg: 'flowDereg' };
  function tab(which) {
    for (const [t, flow] of Object.entries(TABS)) {
      $(t).setAttribute('aria-selected', String(t === which));
      show($(flow), t === which);
    }
    stopCamera();
  }
  for (const t of Object.keys(TABS)) $(t).addEventListener('click', () => tab(t));

  // ---------------------------------------------------------------- receiving from the cold side

  /** Text from a file, paste or camera -> {kind, text}. MQR1 frames are joined, checked and decompressed. */
  function decodeInput(text) {
    const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length && lines.every((l) => l.startsWith('MQR1:'))) {
      const d = C.decodeFrames(lines, zlib, 100000);
      return { kind: d.kind, text: new TextDecoder('utf-8', { fatal: true }).decode(d.payload), note: `Joined ${d.total} frame(s), checksum OK.` };
    }
    return { kind: null, text: String(text), note: '' };
  }

  const receivers = [];
  for (const box of document.querySelectorAll('.recv')) {
    const r = { box, kinds: box.dataset.kinds.split(','), file: box.dataset.file, section: box.closest('section') };
    const input = el('input'); input.type = 'file'; input.hidden = true;
    const load = el('button', 'Load file…'); load.type = 'button';
    const cam = el('button', 'Scan with camera', 'secondary'); cam.type = 'button';
    const stop = el('button', 'Stop camera', 'secondary'); stop.type = 'button'; stop.hidden = true;
    const ta = el('textarea'); ta.rows = 3; ta.spellcheck = false;
    ta.placeholder = 'Or paste MQR1 frames or the file contents here';
    const status = el('p', '', 'qrmeta');
    const err = el('div', '', 'banner err'); err.hidden = true;
    const camBox = el('div'); camBox.hidden = true;
    const actions = el('div', undefined, 'actions');
    actions.append(input, load, cam, stop);
    box.append(actions, camBox, ta, status, err);
    Object.assign(r, { input, cam, stop, ta, status, err, camBox });
    load.onclick = () => input.click();
    input.onchange = async () => { const f = input.files[0]; input.value = ''; if (f) receiveFile(r, f); };
    ta.addEventListener('paste', () => setTimeout(() => { if (ta.value.trim()) receiveText(r, ta.value); }, 0));
    cam.onclick = () => startCamera(r);
    stop.onclick = stopCamera;
    receivers.push(r);
  }

  async function receiveFile(r, f) {
    if (f.size > 200000) { fail(r, 'The file is too large for this.'); return; }
    receiveText(r, await f.text());
  }
  function fail(r, msg) { r.err.textContent = msg; show(r.err, !!msg); }

  async function receiveText(r, text) {
    fail(r, '');
    if (r.section.classList.contains('locked')) { fail(r, 'Finish the step above first.'); return; }
    let d;
    try { d = decodeInput(text); } catch (e) { fail(r, e.message); return; }
    if (d.kind && !r.kinds.includes(d.kind)) { fail(r, `These frames carry "${d.kind}", but this step expects ${r.kinds.map((k) => `"${k}"`).join(' or ')}.`); return; }
    let saved;
    try { saved = await api('put', { name: r.file, text: d.text }); } catch (e) { fail(r, e.message); return; }
    r.status.textContent = `${d.note} Saved ${saved.saved} in the folder.`.trim();
    r.ta.value = '';
    onReceived(r.file, saved.text);
  }

  function onReceived(file, text) {
    if (file === 'datum.json') acceptDatum(text);
    else if (file === 'cold.addr') acceptAddr(text);
    else if (file === 'cold-stake.witness') assemble(flows.register);
    else if (file === 'cold-stake-deregister.witness') assemble(flows.deregister);
    else if (file === 'cold-payment.witness') assemble(flows.selfsend);
  }

  // ---------------------------------------------------------------- camera (one at a time)

  let stream = null, scanTimer = null, collect = null, camFor = null;
  async function startCamera(r) {
    stopCamera();
    fail(r, '');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { fail(r, 'This browser cannot use a camera here.'); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) { fail(r, `The camera could not start (${e.name || e.message}).`); return; }
    camFor = r; collect = null;
    const video = el('video'); video.playsInline = true; video.muted = true;
    const canvas = el('canvas'); canvas.hidden = true;
    const msg = el('p', 'Scanning… point the camera at the cold page\'s QR code.', 'qrmeta');
    r.camBox.replaceChildren(msg, video, canvas);
    show(r.camBox, true); show(r.stop, true); r.cam.hidden = true;
    video.srcObject = stream;
    await video.play();
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    scanTimer = setInterval(() => {
      if (video.readyState < 2 || !video.videoWidth) return;
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const code = window.jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
      if (!code || !code.data) return;
      const f = C.parseFrame(code.data);
      if (!f) return;
      if (!collect) collect = { session: f.session, total: f.total, hash: f.hash, kind: f.kind, frames: new Map() };
      if (f.session !== collect.session || f.total !== collect.total || f.hash !== collect.hash) return;
      collect.frames.set(f.index, code.data.trim());
      msg.textContent = `Transfer ${collect.session} (${collect.kind}): ${collect.frames.size} of ${collect.total} frames.`;
      if (collect.frames.size === collect.total) {
        const lines = [];
        for (let i = 1; i <= collect.total; i++) lines.push(collect.frames.get(i));
        const target = camFor;
        stopCamera();
        receiveText(target, lines.join('\n'));
      }
    }, 150);
  }
  function stopCamera() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (camFor) { show(camFor.camBox, false); show(camFor.stop, false); camFor.cam.hidden = false; camFor.camBox.replaceChildren(); }
    camFor = null;
  }

  // Drops: onto a receiving section; every drop is caught so a stray one cannot leave the page.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const dropReceiver = (e) => receivers.find((r) => !r.section.closest('[hidden]') && r.section.contains(e.target));
  const clearDrop = () => { dragDepth = 0; receivers.forEach((r) => r.section.classList.remove('dropping')); };
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) clearDrop(); });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const r = dropReceiver(e);
    e.dataTransfer.dropEffect = r ? 'copy' : 'none';
    receivers.forEach((x) => x.section.classList.toggle('dropping', x === r));
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const r = dropReceiver(e);
    clearDrop();
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
    if (!r || files.length === 0) return;
    if (files.length > 1) { fail(r, 'Drop one file at a time.'); return; }
    receiveFile(r, files[0]);
  });

  // ---------------------------------------------------------------- the three flows

  const flows = {
    register: {
      kind: 'register', ids: ['r1', 'r2', 'r3', 'r4'], build: 'rBuild', witness: 'cold-stake.witness', datum: null,
      check: C.checkRegistration, unsigned: 'register.unsigned',
      done: 'The registration is on chain. Next, start generation: send cNIGHT to the cold address (or use the self-send tab).',
    },
    deregister: {
      kind: 'deregister', ids: ['d1', 'd2', 'd3', 'd4'], build: 'dBuild', witness: 'cold-stake-deregister.witness', datum: null,
      check: C.checkDeregistration, unsigned: 'deregister.unsigned', hits: [], utxo: '',
      done: 'The deregistration is on chain. To change the Dust address, register again now in the Registration tab (with a datum that names the new Dust key), then move the cNIGHT. To stop DUST generation, move the cNIGHT.',
    },
    selfsend: {
      kind: 'selfsend', ids: ['m1', 'm2', 'm3', 'm4'], build: 'mBuild', witness: 'cold-payment.witness', addr: null,
      check: C.checkSelfSend, unsigned: 'move-cnight.unsigned',
      done: 'The self-send is on chain. DUST should appear at the Dust address about 12 hours from now.',
    },
  };
  const sec = (f, i) => $(f.ids[i]);

  function resetFrom(f, step) {
    for (let i = step; i < 4; i++) unlock(f.ids[i], i === step);
    if (step <= 1) { f.built = null; stopQr(sec(f, 1).querySelector('.built')); sec(f, 1).querySelector('.built').replaceChildren(); }
    if (step <= 2) { f.assembled = null; sec(f, 2).querySelector('.assembled').replaceChildren(); }
    if (step <= 3) { sec(f, 3).querySelector('.submit').replaceChildren(); if (f.poll) clearInterval(f.poll); }
    if (step <= 1) $(f.build).disabled = false;
  }

  /** The datum serves the registration and the deregistration tab (which uses only its stake key hash). */
  function acceptDatum(text, fromDisk) {
    let d;
    try { d = JSON.parse(text); } catch (_) { return; }
    const datum = { stakeKeyHash: d.fields[0].fields[0].bytes, dustPublicKey: d.fields[1].bytes };
    for (const f of [flows.register, flows.deregister]) {
      f.datum = datum;
      if (!fromDisk || !f.built) resetFrom(f, 1);
      $(f.build).disabled = false;
    }
    $('rStake').textContent = $('dStake').textContent = datum.stakeKeyHash;
    $('rDust').textContent = `${datum.dustPublicKey} (${datum.dustPublicKey.length / 2} bytes)`;
    show($('r1Out'), true);
    show($('d1Out'), true);
    lookupRegistrations();
  }

  /** Show, in both tabs, the registrations the stake key has on chain now. */
  function lookupRegistrations() {
    const datum = flows.register.datum;
    if (!datum) return;
    const rBox = $('rRegistered'), dBox = $('dRegistered'), fd = flows.deregister;
    for (const b of [rBox, dBox]) b.replaceChildren(el('p', 'Looking for an existing registration of this stake key…', 'qrmeta'));
    api('registered', { stakeKeyHash: datum.stakeKeyHash }).then((r) => {
      if (flows.register.datum !== datum) return; // another datum arrived meanwhile
      fd.hits = r.hits;
      fd.utxo = '';
      const same = r.hits.some((h) => h.dustPublicKey === datum.dustPublicKey);
      if (r.hits.length === 0) {
        rBox.replaceChildren(el('div', `Not registered yet (${r.total} registrations at the validator).`, 'banner ok'));
        dBox.replaceChildren(el('div', `This stake key has no registration (${r.total} registrations at the validator). There is nothing to deregister.`, 'banner warn'));
        return;
      }
      rBox.replaceChildren(el('div', same
        ? `This stake key is already registered with this Dust key (${r.hits.map((h) => h.utxo).join(', ')}). Another registration would only lock more ADA.`
        : `This stake key is already registered with another Dust key (${r.hits.map((h) => h.dustPublicKey).join(', ')}). To change the Dust address, deregister first (the Deregister tab) and register only after that is on chain: while there are two registrations, no DUST is generated.`, 'banner warn'));
      const list = el('div');
      for (const h of r.hits) {
        const label = el('label', undefined, 'inline');
        if (r.hits.length > 1) {
          const radio = el('input'); radio.type = 'radio'; radio.name = 'dUtxo';
          radio.onchange = () => { fd.utxo = h.utxo; resetFrom(fd, 1); };
          label.append(radio, document.createTextNode(' '));
        }
        label.append(el('span', `${h.utxo}\nDust public key ${h.dustPublicKey}${h.dustPublicKey === datum.dustPublicKey ? '  (the one in the datum)' : ''}\n${C.lovelaceText(BigInt(h.lovelace))} locked`, 'mono'));
        label.style.whiteSpace = 'pre-wrap';
        label.style.display = 'flex';
        label.style.margin = '8px 0';
        list.append(label);
      }
      const head = r.hits.length > 1
        ? el('div', 'This stake key has several registrations, so no DUST is generated for it now. Choose the one to remove; keep exactly one to generate DUST.', 'banner warn')
        : el('div', same
          ? 'Registered with the Dust key in the datum. Deregistering removes it. (To change the Dust address afterwards, make a new datum on the cold page with the new Dust address and use it in the Registration tab.)'
          : 'Registered with a Dust key other than the one in the datum: deregister it here, then register the datum\'s Dust key in the Registration tab once this is on chain.', 'banner info');
      dBox.replaceChildren(head, list);
    }).catch((e) => { for (const b of [rBox, dBox]) b.replaceChildren(el('div', `Could not check existing registrations: ${e.message}`, 'banner warn')); });
  }

  function acceptAddr(text, fromDisk) {
    const f = flows.selfsend;
    const a = text.trim();
    let hex;
    try { hex = JSON.parse(W.bech32_decode(a)).hex; } catch (_) { return; }
    f.addr = { address: a, paymentKeyHash: hex.slice(2, 58), stakeKeyHash: hex.slice(58) };
    $('mAddr').textContent = `${a}\npayment key ${f.addr.paymentKeyHash}, stake key ${f.addr.stakeKeyHash}`;
    show($('m1Out'), true);
    if (!fromDisk || !f.built) resetFrom(f, 1);
    $(f.build).disabled = false;
  }

  function expectFor(f) {
    const networkId = state.network === 'mainnet' ? 1 : 0;
    return f.kind === 'selfsend'
      ? { networkId, paymentKeyHash: f.addr.paymentKeyHash, stakeKeyHash: f.addr.stakeKeyHash, cnightPolicy: state.cnightPolicy }
      : { networkId, validatorHash: state.validatorHash, stakeKeyHash: f.datum.stakeKeyHash, dustPublicKey: f.datum.dustPublicKey };
  }

  async function build(f) {
    const box = sec(f, 1).querySelector('.built');
    resetFrom(f, 1);
    if (f.kind === 'deregister' && f.hits.length > 1 && !f.utxo) {
      box.replaceChildren(el('div', 'Choose in step 1 which registration to remove.', 'banner err')); return;
    }
    $(f.build).disabled = true;
    box.replaceChildren(el('p', 'Building with cardano-cli… (this queries the node and runs the validator)', 'qrmeta'));
    let r;
    try { r = await api('build', { kind: f.kind, gift: f.kind === 'selfsend' && $('mGift').checked, utxo: f.kind === 'deregister' ? f.utxo : '' }); } catch (e) {
      box.replaceChildren(el('div', e.message, 'banner err')); $(f.build).disabled = false; return;
    }
    const log = el('details'); log.append(el('summary', 'Script output'), el('pre', r.log, 'log'));
    $(f.build).disabled = false;
    if (!r.ok) {
      // The scripts mark what to do next with "==> "; a line that sets environment variables is a command to copy.
      const hints = r.log.split('\n').filter((l) => l.startsWith('==> ')).map((l) => l.slice(4));
      const ban = el('div', hints.length ? 'The build failed. What to do:' : 'The build failed. See the script output.', 'banner err');
      for (const h of hints) ban.append(el(/^[A-Z_]+=/.test(h) ? 'pre' : 'p', h, /^[A-Z_]+=/.test(h) ? 'log' : undefined));
      box.replaceChildren(ban, log); log.open = true; return;
    }
    const bytes = C.readTxText(r.unsigned).bytes;
    const cryptoFns = { blake2b: (h, n) => W.blake2b(h, n), bech32: (hrp, h) => W.bech32_encode(hrp, h) };
    const check = f.check(bytes, expectFor(f), cryptoFns);
    const s = check.summary;
    const kv = el('dl', undefined, 'kv');
    const add = (k, v) => kv.append(el('dt', k), el('dd', v));
    add('Transaction id', r.txid || '—');
    if (check.bodyHash !== r.txid) add('Warning', `the page computes body hash ${check.bodyHash}, cardano-cli says ${r.txid}`);
    add('Fee', s.fee !== undefined ? C.lovelaceText(s.fee) : '—');
    if (s.ttl !== undefined) add('Valid until slot', `${s.ttl} (about ${Math.round((Number(s.ttl) - Number(state.tip.slot)) / 60)} minutes from the last refresh)`);
    s.outputs.forEach((o, i) => add(`Output ${i}`, `${o.address.text}\n${C.lovelaceText(o.value.lovelace)}${o.value.assets.map((a) => `\n+ ${a.amount} × ${a.policy}${a.name ? '.' + a.name : ''}`).join('')}`));
    const list = el('ul', undefined, 'checks');
    for (const c of check.checks) list.append(el('li', c.text, c.level));
    const verdict = check.ok
      ? el('div', 'The cold page will accept this transaction: every check it runs passes here too.', 'banner ok')
      : el('div', 'The cold page will refuse this transaction (see the ✗ lines). Do not send it.', 'banner err');
    const qr = el('div');
    const actions = el('div', undefined, 'actions');
    actions.append(downloadLink(f.unsigned, r.unsigned));
    box.replaceChildren(verdict, kv, el('h3', 'What the cold page checks'), list, el('h3', 'Show this to the cold machine'), qr, actions, log);
    if (check.ok) showQr(qr, 'tx', r.unsigned, f.unsigned);
    f.built = { txid: r.txid };
    if (check.ok) unlock(f.ids[2], true);
  }
  $('rBuild').addEventListener('click', () => build(flows.register));
  $('mBuild').addEventListener('click', () => build(flows.selfsend));
  $('dBuild').addEventListener('click', () => build(flows.deregister));
  $('mGift').addEventListener('change', () => { if (flows.selfsend.addr) resetFrom(flows.selfsend, 1); });

  async function assemble(f) {
    const box = sec(f, 2).querySelector('.assembled');
    resetFrom(f, 3);
    unlock(f.ids[2], true);
    box.replaceChildren(el('p', 'Checking the witness and assembling…', 'qrmeta'));
    let r;
    try { r = await api('assemble', { kind: f.kind }); } catch (e) { box.replaceChildren(el('div', e.message, 'banner err')); return; }
    const log = el('details'); log.append(el('summary', 'Script output'), el('pre', r.log, 'log'));
    if (!r.ok) { box.replaceChildren(el('div', 'The witness was refused. See the script output.', 'banner err'), log); log.open = true; return; }
    if (!f.built || r.txid !== f.built.txid || r.unsignedTxid !== f.built.txid) {
      box.replaceChildren(el('div', 'The assembled transaction is not the one built above. Build again.', 'banner err'), log); return;
    }
    const witnessLine = r.log.split('\n').find((l) => l.startsWith('Cold witness:')) || '';
    box.replaceChildren(el('div', `${witnessLine} Assembled transaction ${r.txid}.`, 'banner ok'), log);
    f.assembled = { txid: r.txid };
    unlock(f.ids[3], true);
    renderSubmit(f);
  }

  function renderSubmit(f) {
    const box = sec(f, 3).querySelector('.submit');
    const input = el('input'); input.type = 'text'; input.autocomplete = 'off'; input.style.width = '10em';
    const btn = el('button', 'Submit'); btn.type = 'button';
    const out = el('div');
    const row = el('div', undefined, 'row');
    const l = el('div'); l.append(el('label', 'Confirmation'), input);
    const b = el('div'); b.append(btn);
    row.append(l, b);
    box.replaceChildren(el('p', `Type SUBMIT to send transaction ${f.assembled.txid} to ${state.network === 'mainnet' ? 'MAINNET' : state.network}.`), row, out);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
    btn.onclick = async () => {
      if (input.value.trim() !== 'SUBMIT') { out.replaceChildren(el('div', 'Type SUBMIT (capital letters) to confirm.', 'banner err')); return; }
      btn.disabled = true; input.value = '';
      out.replaceChildren(el('p', 'Submitting…', 'qrmeta'));
      let r;
      try { r = await api('submit', { kind: f.kind, confirm: 'SUBMIT', txid: f.assembled.txid }); } catch (e) {
        out.replaceChildren(el('div', e.message, 'banner err')); btn.disabled = false; return;
      }
      const log = el('details'); log.append(el('summary', 'Script output'), el('pre', r.log, 'log'));
      if (!r.ok) { out.replaceChildren(el('div', 'The node did not accept it. See the script output.', 'banner err'), log); log.open = true; btn.disabled = false; return; }
      const wait = el('p', 'Submitted. Waiting for it to appear on chain…', 'qrmeta');
      out.replaceChildren(wait, log);
      watch(f, r.txid, wait, out);
    };
  }

  function watch(f, txid, wait, out) {
    const started = Date.now();
    const tickOnce = async () => {
      let r;
      try { r = await api('landed', { txid }); } catch (e) { wait.textContent = `Could not ask the node: ${e.message}. Retrying.`; return; }
      if (r.landed) {
        clearInterval(f.poll);
        const lines = Object.entries(r.outputs).map(([ref, v]) => `${ref}\n${v.address}\n${JSON.stringify(v.value)}`);
        wait.replaceWith(el('div', `On chain: ${txid}. ${f.done}`, 'banner ok'), el('pre', lines.join('\n\n')));
        refresh();
        if (f.kind !== 'selfsend') lookupRegistrations();
      } else {
        const min = Math.round((Date.now() - started) / 60000);
        wait.textContent = `Submitted. Not on chain yet (${min} min). A block comes about every 20 seconds; this checks every 10.`;
        if (Date.now() - started > 30 * 60000) { clearInterval(f.poll); wait.textContent += ' Stopped watching after 30 minutes; check with Refresh or an explorer.'; }
      }
    };
    f.poll = setInterval(tickOnce, 10000);
    tickOnce();
  }

  // ---------------------------------------------------------------- start

  if (!TOKEN) { fatal('This page needs the token from the URL that hot/hot-server.py printed (the part after #).'); return; }
  history.replaceState(null, '', location.pathname); // keep the token out of the address bar and history
  for (const f of Object.values(flows)) { resetFrom(f, 1); unlock(f.ids[1], false); $(f.build).disabled = true; }
  const wasmBytes = Uint8Array.from(atob(window.COLD_WASM_B64), (c) => c.charCodeAt(0));
  W({ module_or_path: wasmBytes }).then(refresh).catch((e) => fatal(`The page could not start: ${e && e.message ? e.message : e}`));
})();

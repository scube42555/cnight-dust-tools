// Pure logic for the cold page: CBOR decoding, the registration, deregistration and self-send checks, MQR1 frames, SHA-256.
// No DOM, no network, no WASM: tests/coldtx.test.cjs loads this file in Node with fake inputs.
// Everything handed to these functions came across the air gap and is treated as hostile.
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ bytes and hex

  const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;
  function toHex(b) {
    let s = '';
    for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function fromHex(s) {
    s = String(s).trim();
    if (!HEX_RE.test(s)) throw new Error('Not valid hex (odd length or a non-hex character).');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function eqBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ------------------------------------------------------------------ SHA-256 (synchronous, so it works without crypto.subtle)

  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  function sha256(msg) {
    const bitLen = msg.length * 8;
    const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
    padded.set(msg);
    padded[msg.length] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(padded.length - 4, bitLen >>> 0);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  // ------------------------------------------------------------------ base64url

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function b64urlEncode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
      if (i + 1 < bytes.length) s += B64[(n >> 6) & 63];
      if (i + 2 < bytes.length) s += B64[n & 63];
    }
    return s;
  }
  function b64urlDecode(s) {
    if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error('Not valid base64url.');
    const out = new Uint8Array(Math.floor((s.length * 3) / 4));
    let o = 0;
    for (let i = 0; i < s.length; i += 4) {
      const c = [0, 1, 2, 3].map((k) => (i + k < s.length ? B64.indexOf(s[i + k]) : 0));
      const n = (c[0] << 18) | (c[1] << 12) | (c[2] << 6) | c[3];
      out[o++] = (n >> 16) & 255;
      if (i + 2 < s.length) out[o++] = (n >> 8) & 255;
      if (i + 3 < s.length) out[o++] = n & 255;
    }
    return out.subarray(0, o);
  }

  // ------------------------------------------------------------------ MQR1 frames (must match midnight-cold-hot src/mqr.ts,
  // receiver/receiver.template.html and tools/qr_scan.py: same regex, MAX_FRAMES = 9999)

  const MQR = {
    PREFIX: 'MQR1',
    DEFAULT_CHUNK_CHARS: 300,
    MAX_FRAMES: 9999,
    MAX_OUTPUT_BYTES: 4 * 1024 * 1024,
    FRAME_RE: /^MQR1:([a-z]{1,12}):([0-9a-f]{6}):(\d{1,4}):(\d{1,4}):([0-9a-f]{32}):([A-Za-z0-9_-]+)$/,
  };

  function parseFrame(line) {
    const t = String(line).trim();
    if (t.length > 4000) return undefined;
    const m = MQR.FRAME_RE.exec(t);
    if (!m) return undefined;
    const index = Number(m[3]);
    const total = Number(m[4]);
    if (total < 1 || total > MQR.MAX_FRAMES || index < 1 || index > total) return undefined;
    return { kind: m[1], session: m[2], index, total, hash: m[5], data: m[6] };
  }

  /** zlib format (RFC 1950) like Node's deflateSync/inflateSync, so frames interoperate with midnight-cold-hot. */
  function makeZlib(fflate) {
    return {
      compress: (b) => fflate.zlibSync(b, { level: 9 }),
      decompress: (b, maxBytes) => {
        const parts = [];
        let n = 0;
        let ended = false;
        const u = new fflate.Unzlib((chunk, final) => {
          n += chunk.length;
          if (n > maxBytes) throw new Error(`The data expands beyond ${maxBytes} bytes; refusing it.`);
          parts.push(chunk);
          if (final) ended = true;
        });
        try { u.push(b, true); } catch (e) { throw new Error(`Could not decompress: ${e.message}`); }
        if (!ended) throw new Error('Could not decompress: the data ends early.');
        return concat(parts);
      },
    };
  }

  /** zlib: {compress(bytes) -> bytes, decompress(bytes, maxBytes) -> bytes}; random(n) -> n random bytes. */
  function encodeFrames(kind, payload, zlib, random, chunkChars) {
    chunkChars = chunkChars || MQR.DEFAULT_CHUNK_CHARS;
    if (!/^[a-z]{1,12}$/.test(kind)) throw new Error('The kind must be 1 to 12 lowercase letters.');
    if (payload.length === 0) throw new Error('Nothing to send: the payload is empty.');
    const compressed = zlib.compress(payload);
    const hash = toHex(sha256(compressed)).slice(0, 32);
    const text = b64urlEncode(compressed);
    const total = Math.ceil(text.length / chunkChars);
    if (total > MQR.MAX_FRAMES) throw new Error('Too large for MQR1 frames.');
    const session = toHex(random(3));
    const frames = [];
    for (let i = 0; i < total; i++) {
      frames.push(`${MQR.PREFIX}:${kind}:${session}:${i + 1}:${total}:${hash}:${text.slice(i * chunkChars, (i + 1) * chunkChars)}`);
    }
    return { frames, session, hash };
  }

  /** Join frames (any order, duplicates allowed), check the hash, decompress with a size limit. */
  function decodeFrames(lines, zlib, maxBytes) {
    const wanted = lines.map((l) => String(l).trim()).filter((l) => l.length > 0);
    if (wanted.length === 0) throw new Error('No frames found.');
    const frames = wanted.map((line, i) => {
      const f = parseFrame(line);
      if (!f) throw new Error(`Line ${i + 1} is not a valid MQR1 frame.`);
      return f;
    });
    const first = frames[0];
    const byIndex = new Map();
    for (const f of frames) {
      if (f.kind !== first.kind || f.session !== first.session || f.total !== first.total || f.hash !== first.hash) {
        throw new Error('Frames from different transfers are mixed together.');
      }
      const seen = byIndex.get(f.index);
      if (seen !== undefined && seen !== f.data) throw new Error(`Frame ${f.index} appears twice with different contents.`);
      byIndex.set(f.index, f.data);
    }
    const missing = [];
    for (let i = 1; i <= first.total; i++) if (!byIndex.has(i)) missing.push(i);
    if (missing.length) throw new Error(`Missing frame(s): ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', ...' : ''}`);
    let text = '';
    for (let i = 1; i <= first.total; i++) text += byIndex.get(i);
    const compressed = b64urlDecode(text);
    if (toHex(sha256(compressed)).slice(0, 32) !== first.hash) throw new Error('Checksum mismatch: the data is damaged. Scan again.');
    const payload = zlib.decompress(compressed, maxBytes || MQR.MAX_OUTPUT_BYTES);
    return { kind: first.kind, session: first.session, total: first.total, payload };
  }

  // ------------------------------------------------------------------ CBOR decoder (RFC 8949), keeping byte offsets
  //
  // Node: {t, s, e, ...} where s/e are the start/end offsets in the input, so the transaction body's exact bytes
  // can be hashed. t is one of uint, nint (v = BigInt), bytes, text (v), array (items), map (entries: [k, v][]),
  // tag (tag: BigInt, item), simple (v: true/false/null/undefined), float (v).

  const LIMITS = { depth: 64, items: 200000 };

  function decodeCbor(bytes) {
    let pos = 0;
    let budget = LIMITS.items;
    const need = (n) => {
      if (n > bytes.length - pos) throw new Error('CBOR data ends early (truncated or damaged).');
    };
    const readUint = (ai) => {
      if (ai < 24) return BigInt(ai);
      const len = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : -1;
      if (len < 0) throw new Error(`CBOR: unsupported additional info ${ai}.`);
      need(len);
      let v = 0n;
      for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(bytes[pos++]);
      return v;
    };
    const smallLen = (v) => {
      if (v > BigInt(bytes.length)) throw new Error('CBOR: a length is larger than the data.');
      return Number(v);
    };
    const item = (depth) => {
      if (depth > LIMITS.depth) throw new Error('CBOR: nested too deeply.');
      if (--budget < 0) throw new Error('CBOR: too many items.');
      need(1);
      const s = pos;
      const ib = bytes[pos++];
      const mt = ib >> 5;
      const ai = ib & 31;
      const indefinite = ai === 31;
      if (indefinite && (mt === 0 || mt === 1 || mt === 6)) throw new Error('CBOR: invalid indefinite length.');
      if (ai >= 28 && ai <= 30) throw new Error('CBOR: reserved additional info.');
      switch (mt) {
        case 0: return { t: 'uint', v: readUint(ai), s, e: pos };
        case 1: return { t: 'nint', v: -1n - readUint(ai), s, e: pos };
        case 2:
        case 3: {
          let data;
          if (indefinite) {
            const chunks = [];
            for (;;) {
              need(1);
              if (bytes[pos] === 0xff) { pos++; break; }
              const c = item(depth + 1);
              if (c.t !== (mt === 2 ? 'bytes' : 'text') || c.indef) throw new Error('CBOR: bad chunk in an indefinite string.');
              chunks.push(c.raw);
            }
            data = concat(chunks);
          } else {
            const n = smallLen(readUint(ai));
            need(n);
            data = bytes.slice(pos, pos + n);
            pos += n;
          }
          if (mt === 2) return { t: 'bytes', v: data, raw: data, indef: indefinite, s, e: pos };
          let text;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch (_) { throw new Error('CBOR: text is not valid UTF-8.'); }
          return { t: 'text', v: text, raw: data, indef: indefinite, s, e: pos };
        }
        case 4: {
          const items = [];
          if (indefinite) {
            for (;;) { need(1); if (bytes[pos] === 0xff) { pos++; break; } items.push(item(depth + 1)); }
          } else {
            const n = smallLen(readUint(ai));
            for (let i = 0; i < n; i++) items.push(item(depth + 1));
          }
          return { t: 'array', items, indef: indefinite, s, e: pos };
        }
        case 5: {
          const entries = [];
          if (indefinite) {
            for (;;) { need(1); if (bytes[pos] === 0xff) { pos++; break; } entries.push([item(depth + 1), item(depth + 1)]); }
          } else {
            const n = smallLen(readUint(ai));
            for (let i = 0; i < n; i++) entries.push([item(depth + 1), item(depth + 1)]);
          }
          return { t: 'map', entries, indef: indefinite, s, e: pos };
        }
        case 6: {
          const tag = readUint(ai);
          return { t: 'tag', tag, item: item(depth + 1), s, e: pos };
        }
        default: {
          if (ai === 20) return { t: 'simple', v: false, s, e: pos };
          if (ai === 21) return { t: 'simple', v: true, s, e: pos };
          if (ai === 22) return { t: 'simple', v: null, s, e: pos };
          if (ai === 23) return { t: 'simple', v: undefined, s, e: pos };
          if (ai === 25 || ai === 26 || ai === 27) {
            const n = ai === 25 ? 2 : ai === 26 ? 4 : 8;
            need(n);
            const dv = new DataView(bytes.buffer, bytes.byteOffset + pos, n);
            pos += n;
            return { t: 'float', v: n === 4 ? dv.getFloat32(0) : n === 8 ? dv.getFloat64(0) : NaN, s, e: pos };
          }
          if (indefinite) throw new Error('CBOR: unexpected break.');
          throw new Error(`CBOR: unsupported simple value ${ai}.`);
        }
      }
    };
    const top = item(0);
    if (pos !== bytes.length) throw new Error(`CBOR: ${bytes.length - pos} unexpected byte(s) after the data.`);
    return top;
  }

  // ------------------------------------------------------------------ CBOR helpers

  const isUint = (n) => n && n.t === 'uint';
  /** Unwrap the optional set tag 258 that Conway allows on sets. */
  const untagSet = (n) => (n && n.t === 'tag' && n.tag === 258n ? n.item : n);
  function asArray(n, what) {
    n = untagSet(n);
    if (!n || n.t !== 'array') throw new Error(`${what} is not a list.`);
    return n.items;
  }
  function asMap(n, what) {
    if (!n || n.t !== 'map') throw new Error(`${what} is not a map.`);
    return n.entries;
  }
  function mapByUint(n, what) {
    const m = new Map();
    for (const [k, v] of asMap(n, what)) {
      if (!isUint(k) || k.v > 1000n) throw new Error(`${what} has a key that is not a small number.`);
      const key = Number(k.v);
      if (m.has(key)) throw new Error(`${what} has key ${key} twice.`);
      m.set(key, v);
    }
    return m;
  }
  function asBytes(n, what, len) {
    if (!n || n.t !== 'bytes') throw new Error(`${what} is not a byte string.`);
    if (len !== undefined && n.v.length !== len) throw new Error(`${what} is ${n.v.length} bytes, expected ${len}.`);
    return n.v;
  }
  function asUint(n, what) {
    if (!isUint(n)) throw new Error(`${what} is not a whole number.`);
    return n.v;
  }

  /** Plutus data constructor: tag 121..127 = 0..6, 1280..1400 = 7..127, 102 = [n, fields]. */
  function plutusConstr(n) {
    if (!n || n.t !== 'tag') return undefined;
    const tag = n.tag;
    if (tag >= 121n && tag <= 127n) return { index: Number(tag - 121n), fields: asArray(n.item, 'Constructor fields') };
    if (tag >= 1280n && tag <= 1400n) return { index: Number(tag - 1280n + 7n), fields: asArray(n.item, 'Constructor fields') };
    if (tag === 102n) {
      const a = asArray(n.item, 'Constructor');
      if (a.length !== 2) throw new Error('Malformed general constructor.');
      return { index: Number(asUint(a[0], 'Constructor index')), fields: asArray(a[1], 'Constructor fields') };
    }
    return undefined;
  }

  // ------------------------------------------------------------------ Cardano values and addresses

  const lovelaceText = (v) => {
    const s = v.toString().padStart(7, '0');
    return `${s.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${s.slice(-6)} ADA`;
  };

  /** Value = coin | [coin, multiasset]. Returns {lovelace: BigInt, assets: [{policy, name, amount}]}. */
  function parseValue(n, what) {
    if (isUint(n)) return { lovelace: n.v, assets: [] };
    const a = asArray(n, what);
    if (a.length !== 2) throw new Error(`${what} is malformed.`);
    return { lovelace: asUint(a[0], `${what} coin`), assets: parseMultiAsset(a[1], what, false) };
  }
  function parseMultiAsset(n, what, signed) {
    const out = [];
    for (const [p, assets] of asMap(n, `${what} assets`)) {
      const policy = toHex(asBytes(p, 'A policy id', 28));
      for (const [name, amt] of asMap(assets, `${what} assets of a policy`)) {
        let amount;
        if (amt.t === 'uint' || (signed && amt.t === 'nint')) amount = amt.v;
        else throw new Error(`${what}: an asset amount is not a number.`);
        out.push({ policy, name: toHex(asBytes(name, 'An asset name')), amount });
      }
    }
    return out;
  }

  /** Describe a Shelley address. bech32(hrp, hex) is injected (it lives in the WASM module). */
  function describeAddress(bytes, bech32) {
    if (bytes.length === 0) throw new Error('An address is empty.');
    const header = bytes[0];
    const type = header >> 4;
    const net = header & 15;
    const info = { hex: toHex(bytes), type, network: net, text: '', payment: null, stake: null };
    if (type <= 7) {
      if (bytes.length < 29) throw new Error('An address is too short.');
      info.payment = { script: (type & 1) === 1, hash: toHex(bytes.slice(1, 29)) };
      if (type <= 3) {
        if (bytes.length !== 57) throw new Error('A base address has the wrong length.');
        info.stake = { script: (type & 2) === 2, hash: toHex(bytes.slice(29, 57)) };
      } else if (type >= 6 && bytes.length !== 29) throw new Error('An enterprise address has the wrong length.');
      info.text = bech32(net === 1 ? 'addr' : 'addr_test', info.hex);
    } else if (type === 14 || type === 15) {
      if (bytes.length !== 29) throw new Error('A reward address has the wrong length.');
      info.stake = { script: type === 15, hash: toHex(bytes.slice(1, 29)) };
      info.text = bech32(net === 1 ? 'stake' : 'stake_test', info.hex);
    } else if (type === 8) {
      info.text = `Byron address ${info.hex}`;
      info.network = -1;
    } else {
      throw new Error(`Unknown address type ${type}.`);
    }
    return info;
  }

  /** Transaction output, legacy array or post-Alonzo map. */
  function parseOutput(n, what, bech32) {
    let addr, value, datum = null, datumHash = null, scriptRef = null;
    if (n && n.t === 'array') {
      if (n.items.length < 2 || n.items.length > 3) throw new Error(`${what} is malformed.`);
      addr = n.items[0]; value = n.items[1];
      if (n.items.length === 3) datumHash = toHex(asBytes(n.items[2], `${what} datum hash`, 32));
    } else {
      const m = mapByUint(n, what);
      for (const k of m.keys()) if (k > 3) throw new Error(`${what} has unknown field ${k}.`);
      addr = m.get(0); value = m.get(1);
      if (m.has(2)) {
        const d = asArray(m.get(2), `${what} datum`);
        const kind = asUint(d[0], `${what} datum kind`);
        if (kind === 0n) datumHash = toHex(asBytes(d[1], `${what} datum hash`, 32));
        else if (kind === 1n) {
          const t = d[1];
          if (!t || t.t !== 'tag' || t.tag !== 24n) throw new Error(`${what} inline datum is not wrapped as CBOR-in-CBOR.`);
          const raw = asBytes(t.item, `${what} inline datum`);
          datum = { raw, node: decodeCbor(raw) };
        } else throw new Error(`${what} has an unknown datum kind.`);
      }
      if (m.has(3)) scriptRef = true;
    }
    if (!addr || !value) throw new Error(`${what} has no address or value.`);
    return {
      address: describeAddress(asBytes(addr, `${what} address`), bech32),
      value: parseValue(value, `${what} value`),
      datum, datumHash, scriptRef,
    };
  }

  function parseInputs(n, what) {
    return asArray(n, what).map((i) => {
      const a = asArray(i, `${what} entry`);
      if (a.length !== 2) throw new Error(`${what} entry is malformed.`);
      return `${toHex(asBytes(a[0], 'A transaction id', 32))}#${asUint(a[1], 'An output index')}`;
    });
  }

  // ------------------------------------------------------------------ transaction file input

  /**
   * Accepts a cardano-cli text envelope (JSON with cborHex) or bare hex. Returns {bytes, envelopeType}.
   */
  function readTxText(text) {
    const t = String(text).trim();
    if (t.startsWith('{')) {
      let j;
      try { j = JSON.parse(t); } catch (_) { throw new Error('The file looks like JSON but does not parse.'); }
      if (!j || typeof j.cborHex !== 'string' || typeof j.type !== 'string') throw new Error('The JSON has no "type" and "cborHex".');
      // cardano-cli writes "Unwitnessed Tx ConwayEra" (transaction build), "Tx ConwayEra", or "TxBodyConway" (older build-raw).
      if (!(/^(Unwitnessed |Witnessed )?Tx ConwayEra$/.test(j.type) || j.type === 'TxBodyConway')) {
        throw new Error(`Unexpected envelope type "${j.type}": expected a Conway-era unsigned transaction from cardano-cli.`);
      }
      return { bytes: fromHex(j.cborHex), envelopeType: j.type };
    }
    const hex = t.replace(/\s+/g, '');
    if (!hex) throw new Error('The input is empty.');
    return { bytes: fromHex(hex), envelopeType: null };
  }

  // ------------------------------------------------------------------ the registration checks

  // Conway transaction body keys and what we do with them.
  const BODY_KEYS = {
    0: 'inputs', 1: 'outputs', 2: 'fee', 3: 'ttl', 7: 'auxiliary data hash', 8: 'validity start',
    9: 'mint', 11: 'script data hash', 13: 'collateral inputs', 14: 'required signers', 15: 'network id',
    16: 'collateral return', 17: 'total collateral', 18: 'reference inputs',
  };
  const FORBIDDEN_KEYS = {
    4: 'certificates (could delegate, deregister or otherwise use your stake key)',
    5: 'withdrawals (could withdraw your staking rewards)',
    6: 'protocol parameter update',
    19: 'governance votes',
    20: 'governance proposals',
    21: 'treasury value',
    22: 'treasury donation',
  };
  const FEE_WARN = 3000000n;

  /**
   * expect: {networkId: 0|1, validatorHash, stakeKeyHash, dustPublicKey} (lowercase hex)
   * crypto: {blake2b(hex, len) -> hex, bech32(hrp, hex) -> string}
   * Returns {ok, bodyHash, checks: [{level: 'ok'|'error'|'warn'|'info', text}], summary}.
   * ok is true only when there are no errors. Nothing here throws for a bad transaction: problems become errors.
   */
  function checkRegistration(bytes, expect, crypto) {
    const checks = [];
    const ok = (text) => checks.push({ level: 'ok', text });
    const error = (text) => checks.push({ level: 'error', text });
    const warn = (text) => checks.push({ level: 'warn', text });
    const info = (text) => checks.push({ level: 'info', text });
    const summary = { inputs: [], collateral: [], referenceInputs: [], outputs: [], requiredSigners: [], mint: [] };
    let bodyHash = null;

    try {
      for (const k of ['validatorHash', 'stakeKeyHash']) if (!/^[0-9a-f]{56}$/.test(expect[k] || '')) throw new Error(`Internal: ${k} not set.`);
      if (!/^[0-9a-f]{2,66}$/.test(expect.dustPublicKey || '')) throw new Error('Internal: dustPublicKey not set.');

      const top = decodeCbor(bytes);
      let body, wits = null, isValid = true, aux = null;
      if (top.t === 'array') {
        if (top.items.length !== 4) throw new Error(`A transaction is a list of 4 parts; this one has ${top.items.length}.`);
        [body, wits] = top.items;
        const v = top.items[2];
        if (v.t !== 'simple' || typeof v.v !== 'boolean') throw new Error('The transaction validity flag is not true/false.');
        isValid = v.v;
        aux = top.items[3].t === 'simple' && top.items[3].v === null ? null : top.items[3];
      } else if (top.t === 'map') {
        body = top;
        info('This is a transaction body only (no witness set). The signature covers the body, so this is enough to sign.');
      } else {
        throw new Error('This is not a Cardano transaction (expected a list or a map at the top level).');
      }

      bodyHash = crypto.blake2b(toHex(bytes.slice(body.s, body.e)), 32);
      summary.bodyHash = bodyHash;
      const b = mapByUint(body, 'The transaction body');
      const netOk = (n) => n === expect.networkId;

      // Fields we refuse outright.
      for (const k of b.keys()) {
        if (FORBIDDEN_KEYS[k]) error(`The transaction contains ${FORBIDDEN_KEYS[k]}. A registration never needs this. Do not sign.`);
        else if (!BODY_KEYS[k]) error(`The transaction body has unknown field ${k}. Do not sign.`);
      }
      if (!isValid) error('The transaction is marked invalid (it would only take collateral). Do not sign.');

      // Inputs, collateral, reference inputs (the page cannot see their contents offline).
      if (!b.has(0)) error('The transaction has no inputs.');
      else summary.inputs = parseInputs(b.get(0), 'Inputs');
      if (b.has(13)) summary.collateral = parseInputs(b.get(13), 'Collateral inputs');
      else error('There is no collateral input; a transaction that runs a script needs one.');
      if (b.has(18)) summary.referenceInputs = parseInputs(b.get(18), 'Reference inputs');

      // Fee, validity, network.
      if (!b.has(2)) error('The transaction has no fee.');
      else {
        summary.fee = asUint(b.get(2), 'The fee');
        if (summary.fee > FEE_WARN) warn(`The fee is ${lovelaceText(summary.fee)}, more than expected (about 0.5 to 1 ADA). The sponsor pays it.`);
      }
      if (b.has(3)) summary.ttl = asUint(b.get(3), 'The TTL');
      else warn('The transaction has no expiry slot (TTL), so it stays valid until its inputs are spent.');
      if (b.has(8)) summary.validFrom = asUint(b.get(8), 'The validity start');
      if (b.has(15)) {
        const nid = Number(asUint(b.get(15), 'The network id'));
        if (!netOk(nid)) error(`The transaction is for network id ${nid}, but this page is set to ${expect.networkId}.`);
      }
      if (b.has(16)) summary.collateralReturn = parseOutput(b.get(16), 'The collateral return', crypto.bech32);
      if (b.has(17)) summary.totalCollateral = asUint(b.get(17), 'The total collateral');
      if (b.has(7)) warn('The transaction carries metadata (auxiliary data). A registration does not need it; review it if you did not expect it.');
      if (aux) summary.hasMetadata = true;
      if (!b.has(11)) error('There is no script data hash; the validator could not run.');

      // Required signers: must include the stake key, the only thing this page signs with.
      if (!b.has(14)) error('The transaction does not list any required signer, so the validator would reject it.');
      else {
        summary.requiredSigners = asArray(b.get(14), 'Required signers').map((n) => toHex(asBytes(n, 'A required signer', 28)));
        if (summary.requiredSigners.includes(expect.stakeKeyHash)) ok('Your stake key hash is listed as a required signer.');
        else error('Your stake key hash is not a required signer. This transaction is not a registration for your key.');
      }

      // Mint: exactly one registration token, empty asset name, of the mapping validator.
      if (!b.has(9)) error('Nothing is minted. A registration mints exactly one token.');
      else {
        summary.mint = parseMultiAsset(b.get(9), 'The mint', true);
        const m = summary.mint;
        if (m.length === 1 && m[0].policy === expect.validatorHash && m[0].name === '' && m[0].amount === 1n) {
          ok('Mints exactly 1 registration token of the mapping validator.');
        } else if (m.some((a) => a.policy === expect.validatorHash && a.amount < 0n)) {
          error('The transaction burns a registration token (a deregistration), not a registration. Do not sign here.');
        } else {
          error('The mint is not exactly one registration token of the mapping validator.');
        }
      }

      // Outputs.
      const outs = b.has(1) ? asArray(b.get(1), 'Outputs') : [];
      if (outs.length === 0) error('The transaction has no outputs.');
      summary.outputs = outs.map((o, i) => parseOutput(o, `Output ${i}`, crypto.bech32));
      for (const o of summary.outputs.concat(summary.collateralReturn ? [summary.collateralReturn] : [])) {
        if (o.address.network !== -1 && !netOk(o.address.network)) error(`An output address is for another network: ${o.address.text}`);
      }

      // Output 0 must be the registration UTxO (the validator reads the first output).
      const first = summary.outputs[0];
      if (first) {
        const a = first.address;
        if (a.type === 7 && a.payment && a.payment.hash === expect.validatorHash) ok(`Output 0 goes to the mapping validator address ${a.text}.`);
        else error(`Output 0 must go to the mapping validator address; it goes to ${a.text}.`);
        const assets = first.value.assets;
        if (assets.length === 1 && assets[0].policy === expect.validatorHash && assets[0].name === '' && assets[0].amount === 1n) {
          ok(`Output 0 holds the registration token and ${lovelaceText(first.value.lovelace)}.`);
        } else error('Output 0 must hold exactly the one registration token and ADA, nothing else.');
        if (first.scriptRef) error('Output 0 carries a reference script, which a registration does not need.');
        if (first.datumHash) error('Output 0 has a datum hash; the validator needs an inline datum.');
        if (!first.datum) error('Output 0 has no inline datum.');
        else {
          const d = checkDatum(first.datum.node, expect);
          for (const c of d) checks.push(c);
          summary.datumHex = toHex(first.datum.raw);
        }
      }
      summary.outputs.forEach((o, i) => {
        if (i === 0) return;
        if (o.value.assets.some((x) => x.policy === expect.validatorHash)) error(`Output ${i} also holds a registration token.`);
        if (o.address.payment && !o.address.payment.script && o.address.stake && o.address.stake.hash === expect.stakeKeyHash) {
          info(`Output ${i} goes to an address that uses your stake key (${o.address.text}).`);
        }
      });

      // Witness set: script, redeemer, existing signatures.
      if (wits) inspectWitnesses(wits, expect, crypto, checks, summary);
      if (summary.scriptFound === false && summary.referenceInputs.length === 0) {
        error('The mapping validator script is neither in the transaction nor in a reference input.');
      } else if (summary.scriptFound === false) {
        info('The validator script is expected to come from a reference input (not checkable offline).');
      }
    } catch (e) {
      error(`Could not read the transaction: ${e.message}`);
    }

    return { ok: !checks.some((c) => c.level === 'error') && bodyHash !== null, bodyHash, checks, summary };
  }

  /** Datum = Constr 0 [Constr 0 [stakeKeyHash], dustPublicKey] (DustMappingDatum { c_wallet: VerificationKey(hash), dust_address }). */
  function checkDatum(node, expect) {
    const out = [];
    try {
      const c = plutusConstr(node);
      if (!c || c.index !== 0 || c.fields.length !== 2) throw new Error('it is not Constr 0 with two fields');
      const w = plutusConstr(c.fields[0]);
      if (!w || w.fields.length !== 1) throw new Error('the wallet field is not a credential');
      if (w.index !== 0) throw new Error('the wallet credential is a script, not a key');
      const hash = toHex(asBytes(w.fields[0], 'The stake key hash in the datum', 28));
      const dust = toHex(asBytes(c.fields[1], 'The Dust public key in the datum'));
      if (dust.length / 2 > 33) throw new Error('the Dust public key is longer than 33 bytes');
      if (hash === expect.stakeKeyHash) out.push({ level: 'ok', text: 'The datum names your stake key hash.' });
      else out.push({ level: 'error', text: `The datum names stake key hash ${hash}, not yours. Do not sign.` });
      const chosen = !!expect.dustCustom; // the Dust key was entered on the page, not derived from the recovery phrase
      if (dust === expect.dustPublicKey) {
        out.push({ level: 'ok', text: chosen ? 'The datum names the Dust public key of the Dust address you entered in step 1.'
          : 'The datum names your Dust public key (DUST will go to your Midnight wallet).' });
      } else {
        out.push({ level: 'error', text: `The datum names Dust public key ${dust}, not ${chosen ? 'the one you entered' : 'yours'}: DUST would go to someone else. Do not sign.` });
      }
    } catch (e) {
      out.push({ level: 'error', text: `The inline datum is not a valid registration datum: ${e.message}.` });
    }
    return out;
  }

  /** Redeemers, as a Conway map {[tag, index]: [data, units]} or the older list [[tag, index, data, units]]. Tag 0 = spend, 1 = mint. */
  function readRedeemers(r) {
    const reds = [];
    if (r.t === 'map') {
      for (const [k, v] of r.entries) {
        const ka = asArray(k, 'A redeemer key');
        const va = asArray(v, 'A redeemer value');
        reds.push({ tag: Number(asUint(ka[0], 'Redeemer tag')), index: Number(asUint(ka[1], 'Redeemer index')), data: va[0] });
      }
    } else {
      for (const e of asArray(r, 'Redeemers')) {
        const a = asArray(e, 'A redeemer');
        reds.push({ tag: Number(asUint(a[0], 'Redeemer tag')), index: Number(asUint(a[1], 'Redeemer index')), data: a[2] });
      }
    }
    return reds;
  }

  function inspectWitnesses(wits, expect, crypto, checks, summary) {
    const w = mapByUint(wits, 'The witness set');
    summary.scriptFound = false;
    if (w.has(7)) {
      for (const s of asArray(w.get(7), 'Plutus V3 scripts')) {
        const raw = asBytes(s, 'A Plutus V3 script');
        const h = crypto.blake2b('03' + toHex(raw), 28);
        if (h === expect.validatorHash) summary.scriptFound = true;
        else checks.push({ level: 'warn', text: `The transaction includes another Plutus V3 script (hash ${h}).` });
      }
      if (summary.scriptFound) checks.push({ level: 'ok', text: 'The mapping validator script is included, and its hash matches.' });
    }
    if (w.has(3) || w.has(6)) checks.push({ level: 'warn', text: 'The transaction includes Plutus V1/V2 scripts; a registration uses only V3.' });
    if (w.has(5)) {
      const reds = readRedeemers(w.get(5));
      summary.redeemers = reds.length;
      const mint = reds.filter((x) => x.tag === 1);
      const other = reds.filter((x) => x.tag !== 1);
      if (other.length) checks.push({ level: 'error', text: 'The transaction runs a script for something other than minting. Do not sign.' });
      const c = mint.length === 1 ? plutusConstr(mint[0].data) : undefined;
      if (c && c.index === 0 && c.fields.length === 0) checks.push({ level: 'ok', text: 'The mint redeemer is "register" (Constr 0 []).' });
      else if (c && c.index === 1) checks.push({ level: 'error', text: 'The mint redeemer is Constr 1 (deregister), not register. Do not sign.' });
      else checks.push({ level: 'error', text: 'The mint redeemer is not the register redeemer (Constr 0 []).' });
    } else {
      checks.push({ level: 'error', text: 'The transaction has no redeemer, so the validator cannot run.' });
    }
    if (w.has(0)) {
      const vk = asArray(w.get(0), 'Key witnesses').map((x) => toHex(asBytes(asArray(x, 'A key witness')[0], 'A witness key', 32)));
      summary.existingWitnesses = vk.map((k) => crypto.blake2b(k, 28));
      checks.push({ level: 'info', text: `The transaction already carries ${vk.length} signature(s). The hot machine adds them when it assembles; this is fine.` });
    }
  }

  // ------------------------------------------------------------------ the deregistration checks
  //
  // A deregistration spends the registration UTxO at the mapping validator and burns its token; the validator wants
  // the stake key named in that UTxO's datum as a required signer. To change the Dust address, deregister, then
  // register again with the new Dust key (the validator has no "update"), and move the cNIGHT again.
  //
  // Offline, the page cannot see which UTxO is spent. That is safe here: with no certificates, withdrawals or votes,
  // the stake-key signature is only read by the validator, which accepts it only for a registration of this stake
  // key. So the most this signature can do is remove a registration of yours, which is what you are asking for.
  // Nothing may go back to the validator and nothing may be minted, so no registration can be created or replaced.

  /**
   * expect: {networkId: 0|1, validatorHash, stakeKeyHash} (lowercase hex)
   * Returns {ok, bodyHash, checks, summary} like checkRegistration.
   */
  function checkDeregistration(bytes, expect, crypto) {
    const checks = [];
    const ok = (text) => checks.push({ level: 'ok', text });
    const error = (text) => checks.push({ level: 'error', text });
    const warn = (text) => checks.push({ level: 'warn', text });
    const info = (text) => checks.push({ level: 'info', text });
    const summary = { kind: 'deregister', inputs: [], collateral: [], referenceInputs: [], outputs: [], requiredSigners: [], mint: [] };
    let bodyHash = null;

    try {
      for (const k of ['validatorHash', 'stakeKeyHash']) if (!/^[0-9a-f]{56}$/.test(expect[k] || '')) throw new Error(`Internal: ${k} not set.`);

      const top = decodeCbor(bytes);
      let body, wits = null, isValid = true;
      if (top.t === 'array') {
        if (top.items.length !== 4) throw new Error(`A transaction is a list of 4 parts; this one has ${top.items.length}.`);
        [body, wits] = top.items;
        const v = top.items[2];
        if (v.t !== 'simple' || typeof v.v !== 'boolean') throw new Error('The transaction validity flag is not true/false.');
        isValid = v.v;
        if (!(top.items[3].t === 'simple' && top.items[3].v === null)) summary.hasMetadata = true;
      } else if (top.t === 'map') {
        body = top;
        info('This is a transaction body only (no witness set). The signature covers the body, so this is enough to sign.');
      } else {
        throw new Error('This is not a Cardano transaction (expected a list or a map at the top level).');
      }

      bodyHash = crypto.blake2b(toHex(bytes.slice(body.s, body.e)), 32);
      summary.bodyHash = bodyHash;
      const b = mapByUint(body, 'The transaction body');

      for (const k of b.keys()) {
        if (FORBIDDEN_KEYS[k]) error(`The transaction contains ${FORBIDDEN_KEYS[k]}. A deregistration never needs this. Do not sign.`);
        else if (!BODY_KEYS[k]) error(`The transaction body has unknown field ${k}. Do not sign.`);
      }
      if (!isValid) error('The transaction is marked invalid (it would only take collateral). Do not sign.');

      if (!b.has(0)) error('The transaction has no inputs.');
      else {
        summary.inputs = parseInputs(b.get(0), 'Inputs');
        if (summary.inputs.length < 2) error('A deregistration spends the registration UTxO and at least one sponsor UTxO; this transaction has fewer than two inputs.');
      }
      if (b.has(13)) summary.collateral = parseInputs(b.get(13), 'Collateral inputs');
      else error('There is no collateral input; a transaction that runs a script needs one.');
      if (b.has(18)) summary.referenceInputs = parseInputs(b.get(18), 'Reference inputs');

      if (!b.has(2)) error('The transaction has no fee.');
      else {
        summary.fee = asUint(b.get(2), 'The fee');
        if (summary.fee > FEE_WARN) warn(`The fee is ${lovelaceText(summary.fee)}, more than expected (about 0.5 to 1 ADA). The sponsor pays it.`);
      }
      if (b.has(3)) summary.ttl = asUint(b.get(3), 'The TTL');
      else warn('The transaction has no expiry slot (TTL), so it stays valid until its inputs are spent.');
      if (b.has(8)) summary.validFrom = asUint(b.get(8), 'The validity start');
      if (b.has(15)) {
        const nid = Number(asUint(b.get(15), 'The network id'));
        if (nid !== expect.networkId) error(`The transaction is for network id ${nid}, but this page is set to ${expect.networkId}.`);
      }
      if (b.has(16)) summary.collateralReturn = parseOutput(b.get(16), 'The collateral return', crypto.bech32);
      if (b.has(17)) summary.totalCollateral = asUint(b.get(17), 'The total collateral');
      if (b.has(7)) warn('The transaction carries metadata (auxiliary data). A deregistration does not need it; review it if you did not expect it.');
      if (!b.has(11)) error('There is no script data hash; the validator could not run.');

      if (!b.has(14)) error('The transaction does not list any required signer, so the validator would reject it.');
      else {
        summary.requiredSigners = asArray(b.get(14), 'Required signers').map((n) => toHex(asBytes(n, 'A required signer', 28)));
        if (summary.requiredSigners.includes(expect.stakeKeyHash)) ok('Your stake key hash is listed as a required signer.');
        else error('Your stake key hash is not a required signer. This transaction is not a deregistration for your key.');
      }

      // Mint: exactly one registration token burned, nothing else minted or burned.
      if (!b.has(9)) error('Nothing is burned. A deregistration burns exactly one registration token.');
      else {
        summary.mint = parseMultiAsset(b.get(9), 'The mint', true);
        const m = summary.mint;
        if (m.length === 1 && m[0].policy === expect.validatorHash && m[0].name === '' && m[0].amount === -1n) {
          ok('Burns exactly 1 registration token of the mapping validator, and mints nothing.');
        } else {
          error('The mint field is not exactly one burned registration token of the mapping validator. Do not sign.');
        }
      }

      // Outputs: nothing may go back to the validator or carry a registration token, so no registration is (re)created.
      const outs = b.has(1) ? asArray(b.get(1), 'Outputs') : [];
      if (outs.length === 0) error('The transaction has no outputs.');
      summary.outputs = outs.map((o, i) => parseOutput(o, `Output ${i}`, crypto.bech32));
      let clean = summary.outputs.length > 0;
      const allOuts = summary.outputs.map((o, i) => [o, `Output ${i}`]).concat(summary.collateralReturn ? [[summary.collateralReturn, 'The collateral return']] : []);
      for (const [o, what] of allOuts) {
        if (o.address.network !== -1 && o.address.network !== expect.networkId) error(`An output address is for another network: ${o.address.text}`);
        if (o.address.payment && o.address.payment.hash === expect.validatorHash) {
          clean = false;
          error(`${what} goes to the mapping validator. A deregistration leaves nothing there. Do not sign.`);
        }
        if (o.value.assets.some((x) => x.policy === expect.validatorHash)) {
          clean = false;
          error(`${what} holds a registration token. A deregistration burns it. Do not sign.`);
        }
      }
      if (clean) ok('No output goes to the mapping validator or holds a registration token: no registration is created or replaced.');
      summary.outputs.forEach((o, i) => {
        if (o.datum || o.datumHash) warn(`Output ${i} carries a datum, which a deregistration does not need.`);
        if (o.scriptRef) warn(`Output ${i} carries a reference script, which a deregistration does not need.`);
      });

      // Witness set: the validator, and exactly the two redeemers a deregistration has.
      if (wits) {
        const w = mapByUint(wits, 'The witness set');
        summary.scriptFound = false;
        if (w.has(7)) {
          for (const s of asArray(w.get(7), 'Plutus V3 scripts')) {
            const h = crypto.blake2b('03' + toHex(asBytes(s, 'A Plutus V3 script')), 28);
            if (h === expect.validatorHash) summary.scriptFound = true;
            else error(`The transaction includes another Plutus V3 script (hash ${h}). Do not sign.`);
          }
          if (summary.scriptFound) ok('The mapping validator script is included, and its hash matches.');
        }
        if (w.has(1) || w.has(3) || w.has(6)) error('The transaction includes native or Plutus V1/V2 scripts; a deregistration uses only the mapping validator. Do not sign.');
        if (w.has(5)) {
          const reds = readRedeemers(w.get(5));
          summary.redeemers = reds.length;
          const mint = reds.filter((x) => x.tag === 1);
          const spend = reds.filter((x) => x.tag === 0);
          if (reds.length !== mint.length + spend.length) error('The transaction runs a script for something other than spending and burning (a certificate, withdrawal or vote). Do not sign.');
          const c = mint.length === 1 ? plutusConstr(mint[0].data) : undefined;
          if (c && c.index === 1 && c.fields.length === 0) ok('The mint redeemer is "deregister" (Constr 1 []).');
          else error('The mint redeemer is not the deregister redeemer (Constr 1 []). Do not sign.');
          if (spend.length === 1) ok('One script input is spent: the registration UTxO.');
          else error(`A deregistration spends exactly one script input (the registration UTxO); this transaction spends ${spend.length}. Do not sign.`);
        } else {
          error('The transaction has no redeemer, so the validator cannot run.');
        }
        if (w.has(0)) {
          const vk = asArray(w.get(0), 'Key witnesses').map((x) => toHex(asBytes(asArray(x, 'A key witness')[0], 'A witness key', 32)));
          summary.existingWitnesses = vk.map((k) => crypto.blake2b(k, 28));
          info(`The transaction already carries ${vk.length} signature(s). The hot machine adds them when it assembles; this is fine.`);
        }
        if (summary.scriptFound === false && summary.referenceInputs.length === 0) {
          error('The mapping validator script is neither in the transaction nor in a reference input.');
        } else if (summary.scriptFound === false) {
          info('The validator script is expected to come from a reference input (not checkable offline).');
        }
      }
      info('This page cannot see which registration the inputs spend (that needs the chain). Your stake-key signature can remove only a registration of your own stake key; if you have more than one, check on the hot machine which one is spent.');
      info('DUST keeps being generated for cNIGHT that has not moved since. Move the cNIGHT (a self-send) after this is on chain to stop it, or after registering again to send DUST to the new address.');
    } catch (e) {
      error(`Could not read the transaction: ${e.message}`);
    }

    return { ok: !checks.some((c) => c.level === 'error') && bodyHash !== null, bodyHash, checks, summary };
  }

  // ------------------------------------------------------------------ the cNIGHT self-send checks
  //
  // After the registration, DUST generation starts when the stake key's cNIGHT moves. The self-send spends the
  // wallet's cNIGHT UTxOs and pays everything back to the same address, signed with the payment key.
  //
  // Offline, the page cannot see what the inputs hold. So the rule is: every output goes back to your own address.
  // Then whatever the inputs are (your UTxOs, or a small gift UTxO from the sponsor for the fee), nothing can leave
  // your wallet except the fee, which is shown and capped.

  const SELFSEND_ALLOWED = { 0: 'inputs', 1: 'outputs', 2: 'fee', 3: 'ttl', 7: 'auxiliary data hash', 8: 'validity start', 14: 'required signers', 15: 'network id' };
  const SELFSEND_REFUSED = {
    9: 'a mint or burn',
    11: 'a script data hash (a Plutus script would run)',
    13: 'collateral inputs (only needed when a script runs)',
    16: 'a collateral return',
    17: 'a total collateral',
    18: 'reference inputs',
  };
  const SELFSEND_FEE_MAX = 2000000n;
  const SELFSEND_FEE_WARN = 1000000n;

  /**
   * 'selfsend' if nothing is minted; 'deregister' if the mint field burns something (only a deregistration does);
   * otherwise 'register'. Unreadable -> 'register' (its checks report why). Each kind's checks are complete on their
   * own, so a wrong guess here can only lead to a refusal.
   */
  function txKind(bytes) {
    try {
      const top = decodeCbor(bytes);
      const body = top.t === 'array' ? top.items[0] : top;
      const b = mapByUint(body, 'The transaction body');
      if (!b.has(9)) return 'selfsend';
      try {
        if (parseMultiAsset(b.get(9), 'The mint', true).some((a) => a.amount < 0n)) return 'deregister';
      } catch (_) { /* a malformed mint is reported by the registration checks */ }
      return 'register';
    } catch (_) {
      return 'register';
    }
  }

  /** Base address bytes (hex) for a key payment credential and key stake credential. */
  function baseAddressHex(networkId, paymentKeyHash, stakeKeyHash) {
    return (networkId === 1 ? '01' : '00') + paymentKeyHash + stakeKeyHash;
  }

  /**
   * expect: {networkId, paymentKeyHash, stakeKeyHash, cnightPolicy} (lowercase hex)
   * Returns {ok, bodyHash, checks, summary} like checkRegistration.
   */
  function checkSelfSend(bytes, expect, crypto) {
    const checks = [];
    const ok = (text) => checks.push({ level: 'ok', text });
    const error = (text) => checks.push({ level: 'error', text });
    const warn = (text) => checks.push({ level: 'warn', text });
    const info = (text) => checks.push({ level: 'info', text });
    const summary = { kind: 'selfsend', inputs: [], collateral: [], referenceInputs: [], outputs: [], requiredSigners: [], mint: [] };
    let bodyHash = null;

    try {
      for (const k of ['paymentKeyHash', 'stakeKeyHash', 'cnightPolicy']) if (!/^[0-9a-f]{56}$/.test(expect[k] || '')) throw new Error(`Internal: ${k} not set.`);
      const ownHex = baseAddressHex(expect.networkId, expect.paymentKeyHash, expect.stakeKeyHash);
      summary.ownAddress = crypto.bech32(expect.networkId === 1 ? 'addr' : 'addr_test', ownHex);

      const top = decodeCbor(bytes);
      let body, wits = null, isValid = true;
      if (top.t === 'array') {
        if (top.items.length !== 4) throw new Error(`A transaction is a list of 4 parts; this one has ${top.items.length}.`);
        [body, wits] = top.items;
        const v = top.items[2];
        if (v.t !== 'simple' || typeof v.v !== 'boolean') throw new Error('The transaction validity flag is not true/false.');
        isValid = v.v;
      } else if (top.t === 'map') {
        body = top;
        info('This is a transaction body only (no witness set). The signature covers the body, so this is enough to sign.');
      } else {
        throw new Error('This is not a Cardano transaction (expected a list or a map at the top level).');
      }

      bodyHash = crypto.blake2b(toHex(bytes.slice(body.s, body.e)), 32);
      summary.bodyHash = bodyHash;
      const b = mapByUint(body, 'The transaction body');

      for (const k of b.keys()) {
        if (FORBIDDEN_KEYS[k]) error(`The transaction contains ${FORBIDDEN_KEYS[k]}. Moving cNIGHT never needs this. Do not sign.`);
        else if (SELFSEND_REFUSED[k]) error(`The transaction contains ${SELFSEND_REFUSED[k]}. A self-send does not need it. Do not sign.`);
        else if (!SELFSEND_ALLOWED[k]) error(`The transaction body has unknown field ${k}. Do not sign.`);
      }
      if (!isValid) error('The transaction is marked invalid. Do not sign.');

      if (!b.has(0)) error('The transaction has no inputs.');
      else summary.inputs = parseInputs(b.get(0), 'Inputs');

      if (!b.has(2)) error('The transaction has no fee.');
      else {
        summary.fee = asUint(b.get(2), 'The fee');
        if (summary.fee > SELFSEND_FEE_MAX) error(`The fee is ${lovelaceText(summary.fee)}. A self-send costs about 0.2 ADA; more than ${lovelaceText(SELFSEND_FEE_MAX)} is refused.`);
        else if (summary.fee > SELFSEND_FEE_WARN) warn(`The fee is ${lovelaceText(summary.fee)}, more than the usual 0.2 ADA.`);
        else ok(`The fee is ${lovelaceText(summary.fee)}. It is the only thing that leaves your address.`);
      }
      if (b.has(3)) summary.ttl = asUint(b.get(3), 'The TTL');
      else warn('The transaction has no expiry slot (TTL), so it stays valid until its inputs are spent.');
      if (b.has(8)) summary.validFrom = asUint(b.get(8), 'The validity start');
      if (b.has(15)) {
        const nid = Number(asUint(b.get(15), 'The network id'));
        if (nid !== expect.networkId) error(`The transaction is for network id ${nid}, but this page is set to ${expect.networkId}.`);
      }
      if (b.has(7)) warn('The transaction carries metadata (auxiliary data). A self-send does not need it; review it if you did not expect it.');
      if (b.has(14)) {
        summary.requiredSigners = asArray(b.get(14), 'Required signers').map((n) => toHex(asBytes(n, 'A required signer', 28)));
        const others = summary.requiredSigners.filter((h) => h !== expect.paymentKeyHash);
        if (others.length) error(`The transaction requires signatures from other keys (${others.join(', ')}). A self-send needs only your payment key and the sponsor's input key.`);
      }

      const outs = b.has(1) ? asArray(b.get(1), 'Outputs') : [];
      if (outs.length === 0) error('The transaction has no outputs.');
      summary.outputs = outs.map((o, i) => parseOutput(o, `Output ${i}`, crypto.bech32));
      let cnight = 0n;
      let allOwn = summary.outputs.length > 0;
      summary.outputs.forEach((o, i) => {
        o.own = o.address.hex === ownHex;
        if (!o.own) {
          allOwn = false;
          const sameStake = o.address.stake && o.address.stake.hash === expect.stakeKeyHash;
          error(`Output ${i} goes to ${o.address.text}, which is not your address${sameStake ? ' (it uses your stake key, but another payment key)' : ''}. Everything must come back to ${summary.ownAddress}. Do not sign.`);
        }
        if (o.datum || o.datumHash) error(`Output ${i} carries a datum. A self-send does not need one.`);
        if (o.scriptRef) error(`Output ${i} carries a reference script. A self-send does not need one.`);
        for (const a of o.value.assets) if (a.policy === expect.cnightPolicy) cnight += a.amount;
      });
      if (allOwn) ok(`Every output goes back to your address ${summary.ownAddress} (payment key ${expect.paymentKeyHash.slice(0, 8)}…, your stake key).`);
      summary.cnight = cnight;
      if (cnight > 0n) ok(`cNIGHT moves: ${cnight} unit(s) of policy ${expect.cnightPolicy.slice(0, 12)}… land in a new UTxO at your address.`);
      else error(`No output holds cNIGHT (policy ${expect.cnightPolicy}). This transaction would not start DUST generation.`);

      if (wits) {
        const w = mapByUint(wits, 'The witness set');
        for (const k of w.keys()) {
          if (k === 0) {
            const vk = asArray(w.get(0), 'Key witnesses').map((x) => toHex(asBytes(asArray(x, 'A key witness')[0], 'A witness key', 32)));
            summary.existingWitnesses = vk.map((x) => crypto.blake2b(x, 28));
            info(`The transaction already carries ${vk.length} signature(s). The hot machine adds them when it assembles; this is fine.`);
          } else {
            error('The witness set holds scripts, redeemers, datums or Byron signatures. A self-send uses only key signatures. Do not sign.');
          }
        }
      }
      info('This page cannot see what the inputs hold. That is safe here: whatever they hold comes back to your address, minus the fee.');
    } catch (e) {
      error(`Could not read the transaction: ${e.message}`);
    }

    return { ok: !checks.some((c) => c.level === 'error') && bodyHash !== null, bodyHash, checks, summary };
  }

  // ------------------------------------------------------------------ outputs for the hot machine

  /** cardano-cli datum JSON (for --tx-out-inline-datum-file), same shape as datum-EXAMPLE.json. */
  function datumJson(stakeKeyHash, dustPublicKey) {
    return JSON.stringify({
      constructor: 0,
      fields: [{ constructor: 0, fields: [{ bytes: stakeKeyHash }] }, { bytes: dustPublicKey }],
    }, null, 2) + '\n';
  }

  /** cardano-cli key witness file: [0, [vkey, signature]] in a TxWitness ConwayEra envelope. */
  function witnessEnvelope(vkeyHex, sigHex) {
    if (!/^[0-9a-f]{64}$/.test(vkeyHex) || !/^[0-9a-f]{128}$/.test(sigHex)) throw new Error('Internal: bad witness bytes.');
    return JSON.stringify({
      type: 'TxWitness ConwayEra',
      description: 'Key Witness ShelleyEra',
      cborHex: '8200825820' + vkeyHex + '5840' + sigHex,
    }, null, 4) + '\n';
  }

  root.ColdTx = {
    toHex, fromHex, sha256, b64urlEncode, b64urlDecode,
    MQR, parseFrame, encodeFrames, decodeFrames, makeZlib,
    decodeCbor, readTxText, checkRegistration, checkDatum, describeAddress, lovelaceText,
    txKind, checkSelfSend, checkDeregistration, baseAddressHex,
    datumJson, witnessEnvelope,
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : window);

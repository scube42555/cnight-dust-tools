// Key derivation and signing for the offline (cold) DUST registration page.
//
// The stake key signs the registration; the payment key signs only the cNIGHT self-send that starts generation.
// Derivation is copied from revised-iancoleman.io/wasm-derive/src/lib.rs (same crates, same revs), so the
// keys match that page and the midnight-offline-derive CLI:
//   Cardano stake key  m/1852'/1815'/account'/2/index   BIP32-Ed25519 (Icarus root from the mnemonic entropy)
//   Midnight Dust key  m/44'/2400'/account'/2/index     BIP32 secp256k1 from the BIP39 seed, used as the Dust role seed
//
// Secret keys never leave this module: the page passes the mnemonic in and gets public data or a signature out.
use bech32::{self, FromBase32, ToBase32, Variant};
use bip32::{DerivationPath, XPrv};
use bip39::Mnemonic;
use blake2::{digest::{Update, VariableOutput}, Blake2bVar};
use ed25519_bip32::{DerivationScheme as Scheme, Signature, XPrv as EdXPrv};
use midnight_ledger::dust::{DustPublicKey, DustSecretKey};
use midnight_serialize::Serializable;
use std::str::FromStr;
use wasm_bindgen::prelude::*;

const HARD: u32 = 0x8000_0000;

fn err(e: impl Into<String>) -> JsError {
    JsError::new(&e.into())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if s.len() % 2 != 0 || !s.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("expected an even number of hex digits".into());
    }
    Ok((0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect())
}

fn blake2b_n(data: &[u8], n: usize) -> Vec<u8> {
    let mut h = Blake2bVar::new(n).unwrap();
    h.update(data);
    let mut out = vec![0u8; n];
    h.finalize_variable(&mut out).unwrap();
    out
}

fn b32(hrp: &str, data: &[u8], v: Variant) -> String {
    bech32::encode(hrp, data.to_base32(), v).expect("bech32 encode failed")
}

fn js_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn obj(fields: &[(&str, String)]) -> String {
    let body: Vec<String> = fields.iter().map(|(k, v)| format!("{}:{}", js_str(k), js_str(v))).collect();
    format!("{{{}}}", body.join(","))
}

fn mnemonic(input: &str) -> Result<Mnemonic, String> {
    let words = input.split_whitespace().collect::<Vec<_>>().join(" ");
    Mnemonic::parse(&words).map_err(|e| format!("Invalid mnemonic: {e}"))
}

fn check_path_index(name: &str, v: u32) -> Result<(), String> {
    if v >= HARD { Err(format!("{name} must be below 2^31")) } else { Ok(()) }
}

// ---------------------------------------------------------------- Cardano

fn cardano_root(m: &Mnemonic, passphrase: &str) -> EdXPrv {
    // Icarus master key: PBKDF2-HMAC-SHA512(password = passphrase, salt = entropy, 4096 iterations, 96 bytes)
    let mut master = [0u8; 96];
    pbkdf2::pbkdf2_hmac::<sha2::Sha512>(passphrase.as_bytes(), &m.to_entropy(), 4096, &mut master);
    let key = EdXPrv::normalize_bytes_force3rd(master);
    master.iter_mut().for_each(|b| *b = 0);
    key
}

fn cardano_account(root: &EdXPrv, account: u32) -> EdXPrv {
    root.derive(Scheme::V2, HARD | 1852).derive(Scheme::V2, HARD | 1815).derive(Scheme::V2, HARD | account)
}

// ---------------------------------------------------------------- Midnight

fn dust_public_key(m: &Mnemonic, passphrase: &str, account: u32, index: u32) -> Result<Vec<u8>, String> {
    let seed = m.to_seed(passphrase);
    let path = DerivationPath::from_str(&format!("m/44'/2400'/{account}'/2/{index}")).map_err(|e| e.to_string())?;
    let xprv = XPrv::derive_from_path(seed, &path).map_err(|e| e.to_string())?;
    let key: [u8; 32] = xprv.private_key().to_bytes().into();
    let pk = DustPublicKey::from(DustSecretKey::derive_secret_key(&key.into()));
    let mut out = Vec::new();
    pk.serialize(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

// ---------------------------------------------------------------- exports

/// Public data needed for the registration, as JSON. `network` is "mainnet" or "preprod" (or "preview").
/// The Midnight network only changes the Dust address prefix; the Dust public key is the same on all networks.
#[wasm_bindgen]
pub fn cold_keys(phrase: &str, passphrase: &str, network: &str, account: u32, index: u32) -> Result<String, JsError> {
    check_path_index("Account", account).map_err(err)?;
    check_path_index("Index", index).map_err(err)?;
    let m = mnemonic(phrase).map_err(err)?;
    let mainnet = network == "mainnet";

    let acct = cardano_account(&cardano_root(&m, passphrase), account);
    let stake_vk = acct.derive(Scheme::V2, 2).derive(Scheme::V2, index).public().public_key();
    let pay_vk = acct.derive(Scheme::V2, 0).derive(Scheme::V2, 0).public().public_key();
    let stake_hash = blake2b_n(&stake_vk, 28);
    let pay_hash = blake2b_n(&pay_vk, 28);

    let mut reward = vec![if mainnet { 0xE1 } else { 0xE0 }];
    reward.extend_from_slice(&stake_hash);
    let mut base = vec![if mainnet { 0x01 } else { 0x00 }];
    base.extend_from_slice(&pay_hash);
    base.extend_from_slice(&stake_hash);

    let dust = dust_public_key(&m, passphrase, account, index).map_err(err)?;
    let dust_hrp = if mainnet { "mn_dust".to_string() } else { format!("mn_dust_{network}") };

    Ok(obj(&[
        ("stakePath", format!("m/1852'/1815'/{account}'/2/{index}")),
        ("dustPath", format!("m/44'/2400'/{account}'/2/{index}")),
        ("stakeVkey", hex(&stake_vk)),
        ("stakeKeyHash", hex(&stake_hash)),
        ("stakeAddress", b32(if mainnet { "stake" } else { "stake_test" }, &reward, Variant::Bech32)),
        ("baseAddress", b32(if mainnet { "addr" } else { "addr_test" }, &base, Variant::Bech32)),
        ("dustPublicKey", hex(&dust)),
        ("dustAddress", b32(&dust_hrp, &dust, Variant::Bech32m)),
    ]))
}

/// Sign a 32-byte transaction body hash with the stake key. Returns JSON {vkey, signature}.
/// The page decodes and checks the transaction and computes the hash itself; this only signs.
#[wasm_bindgen]
pub fn sign_with_stake_key(phrase: &str, passphrase: &str, account: u32, index: u32, body_hash_hex: &str)
    -> Result<String, JsError>
{
    check_path_index("Account", account).map_err(err)?;
    check_path_index("Index", index).map_err(err)?;
    let msg = decode_hex(body_hash_hex).map_err(err)?;
    if msg.len() != 32 {
        return Err(err("The body hash must be 32 bytes"));
    }
    let m = mnemonic(phrase).map_err(err)?;
    let key = cardano_account(&cardano_root(&m, passphrase), account).derive(Scheme::V2, 2).derive(Scheme::V2, index);
    let sig: Signature<Vec<u8>> = key.sign(&msg);
    let xpub = key.public();
    if !xpub.verify(&msg, &sig) {
        return Err(err("The signature did not verify; nothing was produced"));
    }
    Ok(obj(&[("vkey", hex(&xpub.public_key())), ("signature", hex(sig.as_ref()))]))
}

/// The payment key m/1852'/1815'/account'/0/payment_index, for moving cNIGHT (a self-send). JSON
/// {paymentPath, paymentVkey, paymentKeyHash}. The page joins the hash with the stake key hash into the address.
#[wasm_bindgen]
pub fn payment_key(phrase: &str, passphrase: &str, account: u32, payment_index: u32) -> Result<String, JsError> {
    check_path_index("Account", account).map_err(err)?;
    check_path_index("Payment index", payment_index).map_err(err)?;
    let m = mnemonic(phrase).map_err(err)?;
    let vk = cardano_account(&cardano_root(&m, passphrase), account)
        .derive(Scheme::V2, 0).derive(Scheme::V2, payment_index).public().public_key();
    Ok(obj(&[
        ("paymentPath", format!("m/1852'/1815'/{account}'/0/{payment_index}")),
        ("paymentVkey", hex(&vk)),
        ("paymentKeyHash", hex(&blake2b_n(&vk, 28))),
    ]))
}

/// Sign a 32-byte transaction body hash with the payment key m/1852'/1815'/account'/0/payment_index.
/// Returns JSON {vkey, signature}. Used only for the cNIGHT self-send, after the page's checks pass.
#[wasm_bindgen]
pub fn sign_with_payment_key(phrase: &str, passphrase: &str, account: u32, payment_index: u32, body_hash_hex: &str)
    -> Result<String, JsError>
{
    check_path_index("Account", account).map_err(err)?;
    check_path_index("Payment index", payment_index).map_err(err)?;
    let msg = decode_hex(body_hash_hex).map_err(err)?;
    if msg.len() != 32 {
        return Err(err("The body hash must be 32 bytes"));
    }
    let m = mnemonic(phrase).map_err(err)?;
    let key = cardano_account(&cardano_root(&m, passphrase), account).derive(Scheme::V2, 0).derive(Scheme::V2, payment_index);
    let sig: Signature<Vec<u8>> = key.sign(&msg);
    let xpub = key.public();
    if !xpub.verify(&msg, &sig) {
        return Err(err("The signature did not verify; nothing was produced"));
    }
    Ok(obj(&[("vkey", hex(&xpub.public_key())), ("signature", hex(sig.as_ref()))]))
}

/// BLAKE2b with an output of `len` bytes (28 for key and script hashes, 32 for a transaction body hash).
#[wasm_bindgen]
pub fn blake2b(data_hex: &str, len: usize) -> Result<String, JsError> {
    if !(1..=64).contains(&len) {
        return Err(err("length must be 1 to 64"));
    }
    Ok(hex(&blake2b_n(&decode_hex(data_hex).map_err(err)?, len)))
}

/// Bech32 (not bech32m) encoding, for showing Cardano addresses.
#[wasm_bindgen]
pub fn bech32_encode(hrp: &str, data_hex: &str) -> Result<String, JsError> {
    let data = decode_hex(data_hex).map_err(err)?;
    bech32::encode(hrp, data.to_base32(), Variant::Bech32).map_err(|e| err(e.to_string()))
}

/// Bech32 decoding: JSON {hrp, hex}. Used to accept a stake address typed for comparison.
#[wasm_bindgen]
pub fn bech32_decode(s: &str) -> Result<String, JsError> {
    let (hrp, data, _) = bech32::decode(s.trim()).map_err(|e| err(e.to_string()))?;
    let bytes = Vec::<u8>::from_base32(&data).map_err(|e| err(e.to_string()))?;
    Ok(obj(&[("hrp", hrp), ("hex", hex(&bytes))]))
}

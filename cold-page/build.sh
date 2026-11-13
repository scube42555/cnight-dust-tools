#!/usr/bin/env bash
# Rebuild the WASM module and the offline page ../dust-register-cold.html. Needs Rust with the
# wasm32-unknown-unknown target, wasm-bindgen-cli 0.2.100 and Python 3. Run the tests afterwards:
#   node --test cold-page/tests/
set -euo pipefail
cd "$(dirname "$0")"
(cd wasm && cargo build --release --target wasm32-unknown-unknown ${CARGO_OFFLINE:+--offline})
wasm-bindgen --target no-modules --no-typescript --out-dir wasm/pkg wasm/target/wasm32-unknown-unknown/release/dust_register_cold.wasm
python3 build_html.py ../dust-register-cold.html

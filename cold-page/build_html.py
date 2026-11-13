#!/usr/bin/env python3
"""Inline the WASM module, its glue, the vendor libraries and the page scripts into one offline HTML file.

usage: build_html.py <out.html> [template ui-script]   (default: src/page.html src/ui.js, the cold page;
       the hot page is: src/hot.html src/hot-ui.js)
"""
import base64, hashlib, pathlib, sys

here = pathlib.Path(__file__).resolve().parent
out = pathlib.Path(sys.argv[1])
template, ui = (sys.argv[2], sys.argv[3]) if len(sys.argv) == 4 else ("src/page.html", "src/ui.js")

def text(p):
    s = (here / p).read_text(encoding="utf-8")
    if "</script" in s.lower():
        sys.exit(f"{p} contains a script end tag; cannot inline it")
    return s

parts = {
    "/*FFLATE*/": text("vendor/fflate-0.8.3.umd.js"),
    "/*QRCODE*/": text("vendor/qrcode-generator-1.4.4.js"),
    "/*JSQR*/": text("vendor/jsQR-1.4.0.js"),
    "/*COLDTX*/": text("src/coldtx.js"),
    "/*WASM_GLUE*/": text("wasm/pkg/dust_register_cold.js"),
    "/*WASM_B64*/": base64.b64encode((here / "wasm/pkg/dust_register_cold_bg.wasm").read_bytes()).decode(),
    "/*UI*/": text(ui),
}
page = (here / template).read_text(encoding="utf-8")
for marker, body in parts.items():
    if page.count(marker) != 1:
        sys.exit(f"marker {marker} must appear exactly once in {template}")
    page = page.replace(marker, body, 1)
out.write_bytes(page.encode("utf-8"))
print(f"Wrote {out} ({out.stat().st_size} bytes)")
print(f"sha256 {hashlib.sha256(out.read_bytes()).hexdigest()}")

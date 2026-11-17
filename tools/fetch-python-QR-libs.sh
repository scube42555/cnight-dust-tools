#!/usr/bin/env bash
# ONLINE machine. Downloads the OpenCV and NumPy wheels that tools/qr_scan.py needs on the cold machine, for that
# machine's Python version, and unzips them into one folder (nothing is installed; no install script runs).
# Copied from midnight-cold-hot (fetch-python-QR-libs.sh); the same folder serves both projects.
#
#   tools/fetch-python-QR-libs.sh [OUT_DIR]      (default ./pylibs)
#
# Environment: PYVER, the cold machine's `python3 --version` without the patch number (default 3.9; Tails 6 has 3.11).
# The wheels are for x86-64 Linux. Use opencv-python-headless instead of opencv-python if you never use --preview.
set -euo pipefail

PYVER="${PYVER:-3.9}"; ABI=cp${PYVER//./}          # 3.11 -> cp311, 3.9 -> cp39
OUT="${1:-pylibs}"
if [[ -e "$OUT" ]]; then
  echo "$OUT already exists; move it away first." >&2
  exit 1
fi
WHEELS="$(mktemp -d)"
trap 'rm -rf "$WHEELS"' EXIT

python3 -m pip download --only-binary=:all: --python-version "$PYVER" --implementation cp \
  --abi "$ABI" --abi abi3 --abi none \
  --platform manylinux_2_28_x86_64 --platform manylinux_2_27_x86_64 --platform manylinux2014_x86_64 \
  "opencv-python>=4.8,<5" numpy -d "$WHEELS"
mkdir "$OUT" && for w in "$WHEELS"/*.whl; do unzip -q "$w" -d "$OUT"; done
echo "Wrote $OUT for Python $PYVER ($(du -sh "$OUT" | cut -f1)):"
ls "$OUT"

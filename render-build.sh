#!/usr/bin/env bash
set -euo pipefail

echo "[render-build] starting build"

echo "[render-build] installing node dependencies"
npm ci

echo "[render-build] building typescript"
npm run build

INSTALL_DEMUCS="${INSTALL_DEMUCS:-0}"
if [[ "${INSTALL_DEMUCS}" != "1" ]]; then
  echo "[render-build] INSTALL_DEMUCS=${INSTALL_DEMUCS}, skipping Demucs install"
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[render-build] python3 not found; cannot install Demucs"
  exit 1
fi

echo "[render-build] checking Python compatibility for Demucs/Torch"
python3 - <<'PY'
import sys

major, minor = sys.version_info[:2]

if (major, minor) > (3, 11):
    raise SystemExit(
        f"[render-build] Demucs install requires Python <= 3.11 for "
        f"torch==2.2.2 / torchaudio==2.2.2. Current Python: {major}.{minor}"
    )

print(f"[render-build] Python version OK: {major}.{minor}")
PY

echo "[render-build] creating local virtual environment for Demucs"
rm -rf .venv-demucs
python3 -m venv .venv-demucs
source .venv-demucs/bin/activate

echo "[render-build] upgrading pip/setuptools/wheel"
python -m pip install -U pip setuptools wheel

echo "[render-build] installing torch + torchaudio (CPU)"
python -m pip install \
  --index-url https://download.pytorch.org/whl/cpu \
  "torch==2.2.2" \
  "torchaudio==2.2.2"

echo "[render-build] installing NumPy < 2 for compatibility"
python -m pip install -U "numpy<2"

echo "[render-build] installing Demucs"
python -m pip install -U "demucs==4.0.1"

echo "[render-build] Demucs install completed successfully"
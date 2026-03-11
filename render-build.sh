#!/usr/bin/env bash
set -euo pipefail

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

echo "[render-build] installing Demucs in local venv"
python3 -m venv .venv-demucs
source .venv-demucs/bin/activate

python -m pip install -U pip setuptools wheel
python -m pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio
# Keep NumPy 1.x for broad compatibility with torch/demucs runtime wheels.
python -m pip install "numpy<2" -U
python -m pip install -U demucs

echo "[render-build] Demucs install completed"

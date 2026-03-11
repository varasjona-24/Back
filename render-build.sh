#!/usr/bin/env sh
set -eu

echo "[render-build] starting build"

echo "[render-build] installing node dependencies"
if ! npm ci --include=dev; then
  echo "[render-build] npm ci failed, retrying with npm install"
  npm install --include=dev
fi

echo "[render-build] building typescript"
npm run build

# Force Demucs installation
INSTALL_DEMUCS=1

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

DEMUCS_PYTHON="python3"
if command -v rm >/dev/null 2>&1; then
  rm -rf .venv-demucs
fi

echo "[render-build] preparing Python environment for Demucs"
if python3 -m venv .venv-demucs >/dev/null 2>&1; then
  DEMUCS_PYTHON="$PWD/.venv-demucs/bin/python"
  echo "[render-build] using virtualenv: .venv-demucs"
else
  echo "[render-build] python3 -m venv unavailable; using system python3"
fi

echo "[render-build] upgrading pip/setuptools/wheel"
"$DEMUCS_PYTHON" -m pip install -U pip setuptools wheel

echo "[render-build] installing torch + torchaudio (CPU)"
"$DEMUCS_PYTHON" -m pip install \
  --index-url https://download.pytorch.org/whl/cpu \
  "torch==2.2.2" \
  "torchaudio==2.2.2"

echo "[render-build] installing NumPy < 2 for compatibility"
"$DEMUCS_PYTHON" -m pip install -U "numpy<2"

echo "[render-build] installing Demucs"
"$DEMUCS_PYTHON" -m pip install -U "demucs==4.0.1"

echo "[render-build] Demucs install completed successfully"

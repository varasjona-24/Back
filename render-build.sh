#!/usr/bin/env sh
set -eu

echo "[render-build] starting build"

echo "[render-build] installing node dependencies"
if [ -d node_modules ] && [ -n "$(find node_modules -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then
  echo "[render-build] node_modules already present, skipping npm install step"
else
  if ! npm ci --include=dev; then
    echo "[render-build] npm ci failed, retrying with npm install"
    npm install --include=dev
  fi
fi

echo "[render-build] building typescript"
npm run build

echo "[render-build] Demucs install is mandatory in this build (INSTALL_DEMUCS is ignored)"

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

PIP_ARGS=""
if [ "$DEMUCS_PYTHON" = "python3" ]; then
  export PIP_BREAK_SYSTEM_PACKAGES=1
  PIP_ARGS="--break-system-packages"
fi
export PIP_DISABLE_PIP_VERSION_CHECK=1

echo "[render-build] ensuring pip is available"
if ! "$DEMUCS_PYTHON" -m pip --version >/dev/null 2>&1; then
  echo "[render-build] pip not found; trying ensurepip"
  if "$DEMUCS_PYTHON" -m ensurepip --upgrade >/dev/null 2>&1; then
    echo "[render-build] ensurepip completed"
  else
    echo "[render-build] ensurepip unavailable; downloading get-pip.py"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py
    elif command -v wget >/dev/null 2>&1; then
      wget -qO /tmp/get-pip.py https://bootstrap.pypa.io/get-pip.py
    else
      echo "[render-build] curl/wget not available and ensurepip failed; cannot install pip"
      exit 1
    fi
    "$DEMUCS_PYTHON" /tmp/get-pip.py $PIP_ARGS
  fi
fi

if ! "$DEMUCS_PYTHON" -m pip --version >/dev/null 2>&1; then
  echo "[render-build] pip setup failed"
  exit 1
fi

echo "[render-build] upgrading pip/setuptools/wheel"
"$DEMUCS_PYTHON" -m pip install $PIP_ARGS -U pip setuptools wheel

echo "[render-build] installing torch + torchaudio (CPU)"
"$DEMUCS_PYTHON" -m pip install \
  $PIP_ARGS \
  --index-url https://download.pytorch.org/whl/cpu \
  "torch==2.2.2" \
  "torchaudio==2.2.2"

echo "[render-build] installing NumPy < 2 for compatibility"
"$DEMUCS_PYTHON" -m pip install $PIP_ARGS -U "numpy<2"

echo "[render-build] installing Demucs"
"$DEMUCS_PYTHON" -m pip install $PIP_ARGS -U "demucs==4.0.1"

echo "[render-build] Demucs install completed successfully"

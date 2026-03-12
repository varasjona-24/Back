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
DEMUCS_TARGET_DIR=""
if command -v rm >/dev/null 2>&1; then
  rm -rf .venv-demucs
fi

echo "[render-build] preparing Python environment for Demucs"
if python3 -m venv .venv-demucs >/dev/null 2>&1; then
  DEMUCS_PYTHON="$PWD/.venv-demucs/bin/python"
  echo "[render-build] using virtualenv: .venv-demucs"
else
  echo "[render-build] python3 -m venv unavailable; using system python3"
  DEMUCS_TARGET_DIR="$PWD/.pydeps"
  rm -rf "$DEMUCS_TARGET_DIR"
  mkdir -p "$DEMUCS_TARGET_DIR"
  echo "[render-build] will install Python deps into $DEMUCS_TARGET_DIR"
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

if [ -n "$DEMUCS_TARGET_DIR" ]; then
  echo "[render-build] installing torch + torchaudio (CPU) into target"
  "$DEMUCS_PYTHON" -m pip install \
    $PIP_ARGS \
    --target "$DEMUCS_TARGET_DIR" \
    --index-url https://download.pytorch.org/whl/cpu \
    "torch==2.2.2" \
    "torchaudio==2.2.2"

  echo "[render-build] installing NumPy < 2 into target"
  "$DEMUCS_PYTHON" -m pip install \
    $PIP_ARGS \
    --target "$DEMUCS_TARGET_DIR" \
    -U "numpy<2"

  echo "[render-build] installing Demucs runtime deps into target"
  "$DEMUCS_PYTHON" -m pip install \
    $PIP_ARGS \
    --target "$DEMUCS_TARGET_DIR" \
    -U \
    "dora-search==0.1.12" \
    "einops==0.8.2" \
    "julius==0.2.7" \
    "lameenc==1.8.2" \
    "pyyaml==6.0.3" \
    "tqdm==4.67.3"

  echo "[render-build] installing Demucs package into target (no deps)"
  "$DEMUCS_PYTHON" -m pip install \
    $PIP_ARGS \
    --target "$DEMUCS_TARGET_DIR" \
    --no-deps \
    -U "demucs==4.0.1"

  echo "[render-build] validating Demucs import from target"
  PYTHONPATH="$DEMUCS_TARGET_DIR${PYTHONPATH:+:$PYTHONPATH}" \
    "$DEMUCS_PYTHON" -c "import demucs, demucs.separate"
else
  echo "[render-build] installing torch + torchaudio (CPU)"
  "$DEMUCS_PYTHON" -m pip install \
    $PIP_ARGS \
    --index-url https://download.pytorch.org/whl/cpu \
    "torch==2.2.2" \
    "torchaudio==2.2.2"

  echo "[render-build] installing NumPy < 2 for compatibility"
  "$DEMUCS_PYTHON" -m pip install $PIP_ARGS -U "numpy<2"

  echo "[render-build] installing Demucs runtime deps"
  "$DEMUCS_PYTHON" -m pip install \
    $PIP_ARGS \
    -U \
    "dora-search==0.1.12" \
    "einops==0.8.2" \
    "julius==0.2.7" \
    "lameenc==1.8.2" \
    "pyyaml==6.0.3" \
    "tqdm==4.67.3"

  echo "[render-build] installing Demucs package (no deps)"
  "$DEMUCS_PYTHON" -m pip install $PIP_ARGS --no-deps -U "demucs==4.0.1"

  echo "[render-build] validating Demucs import"
  "$DEMUCS_PYTHON" -c "import demucs, demucs.separate"
fi

echo "[render-build] Demucs install completed successfully"

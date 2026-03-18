#!/usr/bin/env sh
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$APP_DIR"

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

echo "[render-build] refreshing yt-dlp binary"
node src/scripts/download-ytdlp.mjs

echo "[render-build] building typescript"
npm run build

echo "[render-build] Demucs install is mandatory in this build (INSTALL_DEMUCS is ignored)"

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

if [ -z "$PYTHON_BIN" ]; then
  echo "[render-build] python not found; cannot install Demucs"
  exit 1
fi

echo "[render-build] using Python interpreter: $PYTHON_BIN"
echo "[render-build] checking Python compatibility for Demucs/Torch"
"$PYTHON_BIN" - <<'PY'
import sys

major, minor = sys.version_info[:2]

if (major, minor) > (3, 11):
    raise SystemExit(
        f"[render-build] Demucs install requires Python <= 3.11 for "
        f"torch==2.2.2 / torchaudio==2.2.2. Current Python: {major}.{minor}"
    )

print(f"[render-build] Python version OK: {major}.{minor}")
PY

DEMUCS_PYTHON="$PYTHON_BIN"
DEMUCS_TARGET_DIR=""
if command -v rm >/dev/null 2>&1; then
  rm -rf .venv-demucs
fi

echo "[render-build] preparing Python environment for Demucs"
if "$PYTHON_BIN" -m venv .venv-demucs >/dev/null 2>&1; then
  DEMUCS_PYTHON="$PWD/.venv-demucs/bin/python"
  echo "[render-build] using virtualenv: .venv-demucs"
else
  echo "[render-build] python -m venv unavailable; using system python"
  DEMUCS_TARGET_DIR="$PWD/pydeps"
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
  echo "[render-build] installing Demucs stack into target (CPU pinned)"
  "$DEMUCS_PYTHON" -m pip install \
    $PIP_ARGS \
    --target "$DEMUCS_TARGET_DIR" \
    --index-url https://download.pytorch.org/whl/cpu \
    --extra-index-url https://pypi.org/simple \
    -U \
    "torch==2.2.2" \
    "torchaudio==2.2.2" \
    "numpy<2" \
    "demucs==4.0.1"

  echo "[render-build] validating Demucs import from target"
  PYTHONPATH="$DEMUCS_TARGET_DIR${PYTHONPATH:+:$PYTHONPATH}" \
    "$DEMUCS_PYTHON" -c "import demucs, demucs.separate"
else
  echo "[render-build] installing Demucs stack (CPU pinned)"
  "$DEMUCS_PYTHON" -m pip install \
    $PIP_ARGS \
    --index-url https://download.pytorch.org/whl/cpu \
    --extra-index-url https://pypi.org/simple \
    -U \
    "torch==2.2.2" \
    "torchaudio==2.2.2" \
    "numpy<2" \
    "demucs==4.0.1"

  echo "[render-build] validating Demucs import"
  "$DEMUCS_PYTHON" -c "import demucs, demucs.separate"
fi

echo "[render-build] Demucs install completed successfully"

if [ "${ANIDL_ENABLED:-0}" = "1" ]; then
  echo "[render-build] AniDL enabled, preparing CLI runtime"

  if ! command -v node >/dev/null 2>&1; then
    echo "[render-build] node is required for AniDL build"
    exit 1
  fi

  NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
  if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
    echo "[render-build] AniDL requires Node >= 22. Current major: ${NODE_MAJOR:-unknown}"
    exit 1
  fi

  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@10 --activate >/dev/null 2>&1 || true
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    echo "[render-build] pnpm not found, installing pnpm@10 globally"
    npm install -g pnpm@10
  fi

  ANIDL_REF="${ANIDL_REF:-v5.7.0}"
  ANIDL_REPO="${ANIDL_REPO:-https://github.com/anidl/multi-downloader-nx.git}"
  ANIDL_VENDOR_DIR="$APP_DIR/vendor/multi-downloader-nx"

  echo "[render-build] installing AniDL from ${ANIDL_REPO} (${ANIDL_REF})"
  rm -rf "$ANIDL_VENDOR_DIR"
  mkdir -p "$APP_DIR/vendor"

  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$ANIDL_REF" "$ANIDL_REPO" "$ANIDL_VENDOR_DIR"
  else
    echo "[render-build] git is required to fetch AniDL source"
    exit 1
  fi

  (
    cd "$ANIDL_VENDOR_DIR"
    if ! pnpm install --frozen-lockfile; then
      echo "[render-build] pnpm install with frozen lockfile failed, retrying"
      pnpm install
    fi
    pnpm run prebuild-cli
  )

  if [ ! -f "$ANIDL_VENDOR_DIR/lib/index.js" ]; then
    echo "[render-build] AniDL build did not generate lib/index.js"
    exit 1
  fi

  ANIDL_SHARED_HOME="${ANIDL_SHARED_HOME:-$APP_DIR/.anidl-home}"
  mkdir -p \
    "$ANIDL_SHARED_HOME/config" \
    "$ANIDL_SHARED_HOME/fonts" \
    "$ANIDL_SHARED_HOME/playready" \
    "$ANIDL_SHARED_HOME/widevine" \
    "$ANIDL_SHARED_HOME/videos"

  for cfg in bin-path.yml cli-defaults.yml dir-path.yml gui.yml; do
    src="$ANIDL_VENDOR_DIR/lib/config/$cfg"
    dst="$ANIDL_SHARED_HOME/config/$cfg"
    if [ -f "$src" ] && [ ! -f "$dst" ]; then
      cp "$src" "$dst"
    fi
  done

  echo "[render-build] AniDL CLI prepared successfully"
fi

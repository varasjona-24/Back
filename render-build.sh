#!/usr/bin/env sh
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$APP_DIR"

echo "[render-build] starting build"

warn() {
  echo "[render-build] warning: $1"
}

info() {
  echo "[render-build] $1"
}

YTDLP_REQUIRED="${YTDLP_REQUIRED:-0}"
DEMUCS_STRICT_BUILD="${DEMUCS_STRICT_BUILD:-0}"
ANIDL_STRICT_BUILD="${ANIDL_STRICT_BUILD:-0}"

info "installing node dependencies"
if [ -d node_modules ] && [ -n "$(find node_modules -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then
  info "node_modules already present, skipping npm install step"
else
  if ! npm ci --include=dev; then
    warn "npm ci failed, retrying with npm install"
    npm install --include=dev
  fi
fi

if [ "${SKIP_YTDLP_DOWNLOAD:-0}" = "1" ]; then
  info "skipping yt-dlp download (SKIP_YTDLP_DOWNLOAD=1)"
else
  info "refreshing yt-dlp binary"
  if ! node src/scripts/download-ytdlp.mjs; then
    if [ "$YTDLP_REQUIRED" = "1" ]; then
      echo "[render-build] yt-dlp refresh failed and YTDLP_REQUIRED=1" >&2
      exit 1
    fi
    warn "yt-dlp refresh failed; continuing build"
  fi
fi

info "building typescript"
npm run build

install_demucs() {
  if [ "${INSTALL_DEMUCS:-1}" != "1" ] || [ "${KARAOKE_DEMUCS_ENABLED:-1}" != "1" ]; then
    info "skipping Demucs install (INSTALL_DEMUCS=${INSTALL_DEMUCS:-1}, KARAOKE_DEMUCS_ENABLED=${KARAOKE_DEMUCS_ENABLED:-1})"
    return 0
  fi

  PYTHON_BIN=""
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
  fi

  if [ -z "$PYTHON_BIN" ]; then
    warn "python not found; Demucs will be unavailable"
    return 1
  fi

  info "using Python interpreter: $PYTHON_BIN"
  if ! "$PYTHON_BIN" - <<'PY'
import sys
major, minor = sys.version_info[:2]
if (major, minor) > (3, 11):
    raise SystemExit(
        f"Demucs pinned stack requires Python <= 3.11 (current: {major}.{minor})"
    )
print(f"Python version OK for Demucs: {major}.{minor}")
PY
  then
    warn "python version is incompatible with pinned Demucs stack"
    return 1
  fi

  DEMUCS_PYTHON="$PYTHON_BIN"
  DEMUCS_TARGET_DIR=""
  if command -v rm >/dev/null 2>&1; then
    rm -rf .venv-demucs
  fi

  info "preparing Python environment for Demucs"
  if "$PYTHON_BIN" -m venv .venv-demucs >/dev/null 2>&1; then
    DEMUCS_PYTHON="$PWD/.venv-demucs/bin/python"
    info "using virtualenv: .venv-demucs"
  else
    DEMUCS_TARGET_DIR="$PWD/pydeps"
    rm -rf "$DEMUCS_TARGET_DIR"
    mkdir -p "$DEMUCS_TARGET_DIR"
    warn "python -m venv unavailable; using target directory $DEMUCS_TARGET_DIR"
  fi

  PIP_ARGS=""
  if [ "$DEMUCS_PYTHON" = "python3" ]; then
    export PIP_BREAK_SYSTEM_PACKAGES=1
    PIP_ARGS="--break-system-packages"
  fi
  export PIP_DISABLE_PIP_VERSION_CHECK=1

  if ! "$DEMUCS_PYTHON" -m pip --version >/dev/null 2>&1; then
    info "pip not found; trying ensurepip"
    if ! "$DEMUCS_PYTHON" -m ensurepip --upgrade >/dev/null 2>&1; then
      warn "ensurepip unavailable; trying get-pip.py"
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py || return 1
      elif command -v wget >/dev/null 2>&1; then
        wget -qO /tmp/get-pip.py https://bootstrap.pypa.io/get-pip.py || return 1
      else
        warn "curl/wget not available for get-pip"
        return 1
      fi
      "$DEMUCS_PYTHON" /tmp/get-pip.py $PIP_ARGS || return 1
    fi
  fi

  "$DEMUCS_PYTHON" -m pip install $PIP_ARGS -U pip setuptools wheel || return 1

  if [ -n "$DEMUCS_TARGET_DIR" ]; then
    "$DEMUCS_PYTHON" -m pip install \
      $PIP_ARGS \
      --target "$DEMUCS_TARGET_DIR" \
      --index-url https://download.pytorch.org/whl/cpu \
      --extra-index-url https://pypi.org/simple \
      -U \
      "torch==2.2.2" \
      "torchaudio==2.2.2" \
      "numpy<2" \
      "demucs==4.0.1" || return 1

    PYTHONPATH="$DEMUCS_TARGET_DIR${PYTHONPATH:+:$PYTHONPATH}" \
      "$DEMUCS_PYTHON" -c "import demucs, demucs.separate" || return 1
  else
    "$DEMUCS_PYTHON" -m pip install \
      $PIP_ARGS \
      --index-url https://download.pytorch.org/whl/cpu \
      --extra-index-url https://pypi.org/simple \
      -U \
      "torch==2.2.2" \
      "torchaudio==2.2.2" \
      "numpy<2" \
      "demucs==4.0.1" || return 1

    "$DEMUCS_PYTHON" -c "import demucs, demucs.separate" || return 1
  fi

  info "Demucs install completed successfully"
  return 0
}

install_anidl() {
  if [ "${ANIDL_ENABLED:-0}" != "1" ]; then
    info "AniDL disabled (ANIDL_ENABLED=${ANIDL_ENABLED:-0})"
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    warn "node not found; AniDL will be skipped"
    return 1
  fi

  NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
    warn "AniDL requires Node >= 22 (current major: ${NODE_MAJOR:-unknown})"
    return 1
  fi

  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@10 --activate >/dev/null 2>&1 || true
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    info "pnpm not found, installing pnpm@10 globally"
    npm install -g pnpm@10 || return 1
  fi

  ANIDL_REF="${ANIDL_REF:-v5.7.0}"
  ANIDL_REPO="${ANIDL_REPO:-https://github.com/anidl/multi-downloader-nx.git}"
  ANIDL_VENDOR_DIR="$APP_DIR/vendor/multi-downloader-nx"

  rm -rf "$ANIDL_VENDOR_DIR"
  mkdir -p "$APP_DIR/vendor"

  if command -v git >/dev/null 2>&1; then
    info "cloning AniDL from ${ANIDL_REPO} (${ANIDL_REF})"
    if ! git clone --depth 1 --branch "$ANIDL_REF" "$ANIDL_REPO" "$ANIDL_VENDOR_DIR"; then
      warn "git clone failed for AniDL"
      return 1
    fi
  else
    info "git not found, downloading AniDL source tarball"
    TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t anidl-src)"
    TAR_PATH="$TMP_DIR/anidl.tar.gz"
    CODELOAD_URL="https://codeload.github.com/anidl/multi-downloader-nx/tar.gz/refs/tags/$ANIDL_REF"

    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$CODELOAD_URL" -o "$TAR_PATH" || return 1
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "$TAR_PATH" "$CODELOAD_URL" || return 1
    else
      warn "neither curl nor wget available to fetch AniDL tarball"
      return 1
    fi

    tar -xzf "$TAR_PATH" -C "$TMP_DIR" || return 1
    SRC_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name 'multi-downloader-nx-*' | head -n 1)"
    if [ -z "$SRC_DIR" ] || [ ! -d "$SRC_DIR" ]; then
      warn "failed to unpack AniDL source archive"
      return 1
    fi
    mv "$SRC_DIR" "$ANIDL_VENDOR_DIR"
  fi

  (
    cd "$ANIDL_VENDOR_DIR"
    if ! pnpm install --frozen-lockfile; then
      warn "pnpm --frozen-lockfile failed, retrying without frozen lockfile"
      pnpm install
    fi
    pnpm run prebuild-cli
  ) || return 1

  if [ ! -f "$ANIDL_VENDOR_DIR/lib/index.js" ]; then
    warn "AniDL build did not generate lib/index.js"
    return 1
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

  info "AniDL CLI prepared successfully"
  return 0
}

if ! install_demucs; then
  if [ "$DEMUCS_STRICT_BUILD" = "1" ]; then
    echo "[render-build] Demucs install failed and DEMUCS_STRICT_BUILD=1" >&2
    exit 1
  fi
  warn "Demucs setup failed; runtime will fallback to ffmpeg mode"
fi

if ! install_anidl; then
  if [ "$ANIDL_STRICT_BUILD" = "1" ]; then
    echo "[render-build] AniDL setup failed and ANIDL_STRICT_BUILD=1" >&2
    exit 1
  fi
  warn "AniDL setup failed; service will deploy without AniDL support"
fi

info "build finished"

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
INSTALL_DEMUCS="${INSTALL_DEMUCS:-0}"
DEMUCS_STRICT_BUILD="${DEMUCS_STRICT_BUILD:-0}"

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
  if [ "$INSTALL_DEMUCS" != "1" ] || [ "${KARAOKE_DEMUCS_ENABLED:-1}" != "1" ]; then
    info "skipping Demucs install (INSTALL_DEMUCS=$INSTALL_DEMUCS, KARAOKE_DEMUCS_ENABLED=${KARAOKE_DEMUCS_ENABLED:-1})"
    return 0
  fi

  py_is_compatible() {
    "$1" - <<'PY'
import sys
major, minor = sys.version_info[:2]
if (major, minor) > (3, 11):
    raise SystemExit(1)
PY
  }

  PYTHON_BIN=""
  if [ -n "${DEMUCS_PYTHON_BIN:-}" ] && command -v "${DEMUCS_PYTHON_BIN}" >/dev/null 2>&1; then
    if py_is_compatible "${DEMUCS_PYTHON_BIN}"; then
      PYTHON_BIN="${DEMUCS_PYTHON_BIN}"
    else
      warn "DEMUCS_PYTHON_BIN is incompatible (requires <=3.11): ${DEMUCS_PYTHON_BIN}"
    fi
  fi

  if [ -z "$PYTHON_BIN" ] && command -v python3 >/dev/null 2>&1; then
    if py_is_compatible python3; then
      PYTHON_BIN="python3"
    fi
  fi

  if [ -z "$PYTHON_BIN" ] && command -v python >/dev/null 2>&1; then
    if py_is_compatible python; then
      PYTHON_BIN="python"
    fi
  fi

  if [ -z "$PYTHON_BIN" ]; then
    info "compatible Python (<=3.11) not found, trying uv bootstrap"

    if ! command -v uv >/dev/null 2>&1; then
      if command -v curl >/dev/null 2>&1; then
        curl -LsSf https://astral.sh/uv/install.sh | sh || return 1
      elif command -v wget >/dev/null 2>&1; then
        wget -qO- https://astral.sh/uv/install.sh | sh || return 1
      else
        warn "curl/wget not available to install uv"
        return 1
      fi
      export PATH="$HOME/.local/bin:$PATH"
    fi

    if command -v uv >/dev/null 2>&1; then
      uv python install 3.11 || return 1
      PYTHON_BIN="$(uv python find 3.11 2>/dev/null || true)"
    fi

    if [ -z "$PYTHON_BIN" ] || [ ! -x "$PYTHON_BIN" ]; then
      warn "unable to provision Python 3.11 for Demucs"
      return 1
    fi
  fi

  info "using Python interpreter for Demucs: $PYTHON_BIN"

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

if ! install_demucs; then
  if [ "$DEMUCS_STRICT_BUILD" = "1" ]; then
    echo "[render-build] Demucs install failed and DEMUCS_STRICT_BUILD=1" >&2
    exit 1
  fi
  warn "Demucs setup failed; runtime will fallback to ffmpeg mode"
fi

info "build finished"

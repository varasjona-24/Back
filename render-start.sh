#!/usr/bin/env sh
set -eu

echo "[render-start] starting service"

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

if [ "${KARAOKE_DEMUCS_ENABLED:-1}" = "1" ]; then
  DEMUCS_PYTHON=""
  DEMUCS_VENV_PYTHON="$APP_DIR/.venv-demucs/bin/python"
  DEMUCS_PYDEPS_DIR="$APP_DIR/pydeps"
  LEGACY_PYDEPS_DIR="$APP_DIR/.pydeps"

  if [ -x "$DEMUCS_VENV_PYTHON" ]; then
    DEMUCS_PYTHON="$DEMUCS_VENV_PYTHON"
    echo "[render-start] Demucs detected in .venv-demucs"
  elif [ -d "$DEMUCS_PYDEPS_DIR" ] && [ -n "$PYTHON_BIN" ]; then
    export PYTHONPATH="$DEMUCS_PYDEPS_DIR${PYTHONPATH:+:$PYTHONPATH}"
    DEMUCS_PYTHON="$PYTHON_BIN"
    echo "[render-start] Demucs configured from pydeps via PYTHONPATH"
  elif [ -d "$LEGACY_PYDEPS_DIR" ] && [ -n "$PYTHON_BIN" ]; then
    export PYTHONPATH="$LEGACY_PYDEPS_DIR${PYTHONPATH:+:$PYTHONPATH}"
    DEMUCS_PYTHON="$PYTHON_BIN"
    echo "[render-start] Demucs configured from legacy .pydeps via PYTHONPATH"
  elif [ -n "$PYTHON_BIN" ]; then
    DEMUCS_PYTHON="$PYTHON_BIN"
    echo "[render-start] Demucs configured from system $PYTHON_BIN"
  else
    echo "[render-start] python interpreter not found in runtime PATH"
  fi

  if [ -n "$DEMUCS_PYTHON" ]; then
    if ! "$DEMUCS_PYTHON" -c "import demucs" >/dev/null 2>&1; then
      echo "[render-start] warning: demucs import check failed at startup, but runtime command will still be used"
    fi

    if [ -z "${KARAOKE_DEMUCS_CMD:-}" ]; then
      export KARAOKE_DEMUCS_CMD="$DEMUCS_PYTHON -m demucs.separate -n {model} --two-stems=vocals --device cpu --shifts 1 --segment 7 --overlap 0.25 -o {outdir} {input}"
      echo "[render-start] KARAOKE_DEMUCS_CMD not set, auto-configured"
    else
      echo "[render-start] using custom KARAOKE_DEMUCS_CMD"
    fi
  else
    echo "[render-start] Demucs requested but not installed; forcing fallback mode"
    export KARAOKE_DEMUCS_ENABLED=0
  fi
fi

cd "$APP_DIR"
exec node dist/server.js

#!/usr/bin/env sh
set -eu

echo "[render-start] starting service"

if [ "${KARAOKE_DEMUCS_ENABLED:-1}" = "1" ]; then
  DEMUCS_PYTHON=""
  DEMUCS_VENV_PYTHON="$PWD/.venv-demucs/bin/python"
  DEMUCS_PYDEPS_DIR="$PWD/.pydeps"

  if [ -x "$DEMUCS_VENV_PYTHON" ] && "$DEMUCS_VENV_PYTHON" -c "import demucs" >/dev/null 2>&1; then
    DEMUCS_PYTHON="$DEMUCS_VENV_PYTHON"
    echo "[render-start] Demucs detected in .venv-demucs"
  elif [ -d "$DEMUCS_PYDEPS_DIR" ] && command -v python3 >/dev/null 2>&1 && PYTHONPATH="$DEMUCS_PYDEPS_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c "import demucs" >/dev/null 2>&1; then
    export PYTHONPATH="$DEMUCS_PYDEPS_DIR${PYTHONPATH:+:$PYTHONPATH}"
    DEMUCS_PYTHON="python3"
    echo "[render-start] Demucs detected in .pydeps via PYTHONPATH"
  elif command -v python3 >/dev/null 2>&1 && python3 -c "import demucs" >/dev/null 2>&1; then
    DEMUCS_PYTHON="python3"
    echo "[render-start] Demucs detected in system python3"
  fi

  if [ -n "$DEMUCS_PYTHON" ]; then
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

exec npm start

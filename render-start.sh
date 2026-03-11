#!/usr/bin/env bash
set -euo pipefail

echo "[render-start] starting service"

if [[ "${KARAOKE_DEMUCS_ENABLED:-0}" == "1" ]]; then
  DEMUCS_PYTHON="$PWD/.venv-demucs/bin/python"

  if [[ -x "$DEMUCS_PYTHON" ]]; then
    if "$DEMUCS_PYTHON" -c "import demucs" >/dev/null 2>&1; then
      if [[ -z "${KARAOKE_DEMUCS_CMD:-}" ]]; then
        export KARAOKE_DEMUCS_CMD="$DEMUCS_PYTHON -m demucs.separate -n {model} --two-stems=vocals --device cpu --shifts 1 --segment 7 --overlap 0.25 -o {outdir} {input}"
        echo "[render-start] KARAOKE_DEMUCS_CMD not set, using local .venv-demucs python"
      else
        echo "[render-start] using custom KARAOKE_DEMUCS_CMD"
      fi
    else
      echo "[render-start] Demucs requested but not installed in .venv-demucs; forcing fallback mode"
      export KARAOKE_DEMUCS_ENABLED=0
    fi
  else
    echo "[render-start] Demucs requested but .venv-demucs is missing; forcing fallback mode"
    export KARAOKE_DEMUCS_ENABLED=0
  fi
fi

exec npm start
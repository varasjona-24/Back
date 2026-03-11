#!/usr/bin/env bash
set -euo pipefail

if [[ "${KARAOKE_DEMUCS_ENABLED:-0}" == "1" ]]; then
  if [[ -x ".venv-demucs/bin/python" ]]; then
    if [[ -z "${KARAOKE_DEMUCS_CMD:-}" ]]; then
      export KARAOKE_DEMUCS_CMD="$PWD/.venv-demucs/bin/python -m demucs.separate -n {model} --two-stems=vocals --device cpu --shifts 1 --segment 7 --overlap 0.25 -o {outdir} {input}"
      echo "[render-start] KARAOKE_DEMUCS_CMD not set, using local .venv-demucs python"
    fi
  else
    echo "[render-start] Demucs requested but .venv-demucs missing; forcing fallback mode"
    export KARAOKE_DEMUCS_ENABLED=0
  fi
fi

exec npm start

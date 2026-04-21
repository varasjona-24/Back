#!/usr/bin/env sh
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$APP_DIR"

if [ -x ./render-start.sh ]; then
  exec ./render-start.sh
fi

exec node dist/server.js

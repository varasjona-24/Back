#!/usr/bin/env sh
set -eu

if [ "$#" -lt 5 ]; then
  echo "[anidl-wrapper] usage: anidl-render-wrapper.sh <url> <outdir> <kind> <format> <quality>" >&2
  exit 2
fi

URL="$1"
OUTDIR="$2"
KIND="$3"
FORMAT="$4"
QUALITY="$5"

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ANIDL_NODE_BIN="${ANIDL_NODE_BIN:-node}"
ANIDL_ENTRY="${ANIDL_ENTRY:-$APP_DIR/vendor/multi-downloader-nx/lib/index.js}"
ANIDL_SHARED_HOME="${ANIDL_SHARED_HOME:-$APP_DIR/.anidl-home}"

if ! command -v "$ANIDL_NODE_BIN" >/dev/null 2>&1; then
  echo "[anidl-wrapper] node binary not found: $ANIDL_NODE_BIN" >&2
  exit 1
fi

if [ ! -f "$ANIDL_ENTRY" ]; then
  echo "[anidl-wrapper] AniDL entrypoint not found: $ANIDL_ENTRY" >&2
  exit 1
fi

mkdir -p "$OUTDIR"

JOB_HOME="$OUTDIR/anidl-home"
JOB_CFG_DIR="$JOB_HOME/config"
mkdir -p "$JOB_CFG_DIR"

if [ -d "$ANIDL_SHARED_HOME/config" ]; then
  cp -R "$ANIDL_SHARED_HOME/config/." "$JOB_CFG_DIR/" 2>/dev/null || true
fi

for d in fonts playready widevine; do
  if [ -d "$ANIDL_SHARED_HOME/$d" ] && [ ! -d "$JOB_HOME/$d" ]; then
    cp -R "$ANIDL_SHARED_HOME/$d" "$JOB_HOME/$d" 2>/dev/null || true
  fi
done

mkdir -p "$JOB_HOME/fonts" "$JOB_HOME/playready" "$JOB_HOME/widevine" "$JOB_HOME/videos"

cat > "$JOB_CFG_DIR/dir-path.user.yml" <<'YAML'
content: ${wdir}/videos/
trash: ${wdir}/videos/_trash/
fonts: ${wdir}/fonts/
config: ${wdir}/config
YAML

for cfg in bin-path.yml cli-defaults.yml gui.yml; do
  if [ ! -f "$JOB_CFG_DIR/$cfg" ] && [ -f "$APP_DIR/vendor/multi-downloader-nx/lib/config/$cfg" ]; then
    cp "$APP_DIR/vendor/multi-downloader-nx/lib/config/$cfg" "$JOB_CFG_DIR/$cfg"
  fi
done

if [ -n "${ANIDL_FORCE_SERVICE:-}" ]; then
  SERVICE="$ANIDL_FORCE_SERVICE"
else
  URL_LOWER="$(printf '%s' "$URL" | tr '[:upper:]' '[:lower:]')"
  case "$URL_LOWER" in
    *crunchyroll.com*) SERVICE="crunchy" ;;
    *hidive.com*) SERVICE="hidive" ;;
    *animationdigitalnetwork.*|*adn.fr*) SERVICE="adn" ;;
    *)
      echo "[anidl-wrapper] unsupported AniDL URL: $URL" >&2
      exit 1
      ;;
  esac
fi

extract_after() {
  marker="$1"
  printf '%s' "$URL" | sed -n "s#.*$marker\\([^/?#]*\\).*#\\1#p"
}

extract_query() {
  key="$1"
  printf '%s' "$URL" | sed -n "s#.*[?&]$key=\\([^&#]*\\).*#\\1#p"
}

SERVICE_ID=""
EP_SELECTION=""
EXTID=""
SERIES_ID=""
USE_ALL="1"

if [ -n "${ANIDL_FORCE_S:-}" ]; then
  SERVICE_ID="$ANIDL_FORCE_S"
fi
if [ -n "${ANIDL_FORCE_E:-}" ]; then
  EP_SELECTION="$ANIDL_FORCE_E"
fi
if [ -n "${ANIDL_FORCE_EXTID:-}" ]; then
  EXTID="$ANIDL_FORCE_EXTID"
  USE_ALL="0"
fi
if [ -n "${ANIDL_FORCE_SERIES:-}" ]; then
  SERIES_ID="$ANIDL_FORCE_SERIES"
fi

if [ "$SERVICE" = "crunchy" ] && [ -z "$SERVICE_ID" ] && [ -z "$EXTID" ] && [ -z "$SERIES_ID" ]; then
  WATCH_ID="$(extract_after '/watch/')"
  SERIES_URL_ID="$(extract_after '/series/')"
  SEASON_URL_ID="$(extract_after '/season/')"

  if [ -n "$WATCH_ID" ]; then
    EXTID="$WATCH_ID"
    USE_ALL="0"
  elif [ -n "$SERIES_URL_ID" ]; then
    SERIES_ID="$SERIES_URL_ID"
  elif [ -n "$SEASON_URL_ID" ]; then
    SERVICE_ID="$SEASON_URL_ID"
  fi
fi

if [ "$SERVICE" != "crunchy" ] && [ -z "$SERVICE_ID" ]; then
  SERVICE_ID="$(extract_query 'seasonId')"
fi
if [ "$SERVICE" != "crunchy" ] && [ -z "$SERVICE_ID" ]; then
  SERVICE_ID="$(extract_query 'seriesId')"
fi
if [ "$SERVICE" != "crunchy" ] && [ -z "$SERVICE_ID" ]; then
  SERVICE_ID="$(extract_query 'id')"
fi
if [ "$SERVICE" != "crunchy" ] && [ -z "$SERVICE_ID" ]; then
  SERVICE_ID="$(printf '%s' "$URL" | sed -E 's#^[^:]+://[^/]+/?##; s/[?#].*$//; s#/$##; s#.*/##')"
fi

if [ -z "$SERVICE_ID" ] && [ -z "$EXTID" ] && [ -z "$SERIES_ID" ]; then
  echo "[anidl-wrapper] could not derive AniDL ID from URL. Set ANIDL_FORCE_S / ANIDL_FORCE_EXTID / ANIDL_FORCE_SERIES." >&2
  exit 1
fi

QUALITY_LEVEL="0"
case "$QUALITY" in
  low) QUALITY_LEVEL="${ANIDL_Q_LOW:-4}" ;;
  medium) QUALITY_LEVEL="${ANIDL_Q_MEDIUM:-2}" ;;
  high|"") QUALITY_LEVEL="${ANIDL_Q_HIGH:-0}" ;;
esac

set -- \
  "$ANIDL_NODE_BIN" "$ANIDL_ENTRY" \
  --service "$SERVICE" \
  -q "$QUALITY_LEVEL" \
  --skipUpdate \
  --mp4 \
  --forceMuxer ffmpeg

if [ "${ANIDL_NOSUBS:-1}" = "1" ]; then
  set -- "$@" --nosubs
fi

if [ -n "${ANIDL_TOKEN:-}" ] && [ "$SERVICE" = "crunchy" ]; then
  set -- "$@" --token "$ANIDL_TOKEN"
fi

if [ -n "${ANIDL_USERNAME:-}" ] && [ -n "${ANIDL_PASSWORD:-}" ]; then
  set -- "$@" --username "$ANIDL_USERNAME" --password "$ANIDL_PASSWORD" --auth
fi

if [ -n "${ANIDL_DUBLANG:-}" ]; then
  set -- "$@" --dubLang "$ANIDL_DUBLANG"
fi

if [ -n "$EXTID" ]; then
  set -- "$@" --extid "$EXTID"
elif [ -n "$SERIES_ID" ]; then
  set -- "$@" --series "$SERIES_ID"
  if [ "$USE_ALL" = "1" ]; then
    set -- "$@" --all
  fi
elif [ -n "$SERVICE_ID" ]; then
  set -- "$@" -s "$SERVICE_ID"
  if [ -n "$EP_SELECTION" ]; then
    set -- "$@" -e "$EP_SELECTION"
  elif [ "$USE_ALL" = "1" ]; then
    set -- "$@" --all
  fi
fi

if [ -n "${ANIDL_EXTRA_ARGS:-}" ]; then
  # shellcheck disable=SC2086
  set -- "$@" $ANIDL_EXTRA_ARGS
fi

echo "[anidl-wrapper] service=$SERVICE kind=$KIND format=$FORMAT quality=$QUALITY_LEVEL outdir=$OUTDIR"
contentDirectory="$JOB_HOME" "$@"

mkdir -p "$ANIDL_SHARED_HOME/config"
for cfg in cr_sess.yml hd_sess.yml adn_sess.yml cr_token.yml hd_token.yml adn_token.yml hd_new_token.yml; do
  if [ -f "$JOB_CFG_DIR/$cfg" ]; then
    cp "$JOB_CFG_DIR/$cfg" "$ANIDL_SHARED_HOME/config/$cfg" 2>/dev/null || true
  fi
done

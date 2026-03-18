# Back (API)

This repository contains a small TypeScript Express API for audio streaming.

Quick start

1. Install deps: `npm install`
2. Build: `npm run build`
3. Start: `npm start` (runs `node dist/server.js`)
4. Development: `npm run dev` (runs `ts-node src/server.ts`)
5. Smoke test: `npm run smoke`

Notes

- To stream YouTube audio you must install `yt-dlp-wrap`:
  `npm install yt-dlp-wrap`.
- The project uses ESM (`type: module`) and Node `--experimental-modules` compatible imports.
- Optional AniDL integration for Crunchyroll/Hidive/ADN downloads:
  - `ANIDL_ENABLED=1`
  - `ANIDL_CMD_TEMPLATE='your-command {url} {outdir} {kind} {format} {quality}'`
  - `ANIDL_TIMEOUT_MS=1800000` (default 30 min)
  - If `ANIDL_ENABLED` is omitted, AniDL auto-enables when `ANIDL_CMD_TEMPLATE` is present.
  - Available placeholders in `ANIDL_CMD_TEMPLATE`: `{url}`, `{outdir}`, `{kind}`, `{format}`, `{quality}`
  - Also exported as env vars for the spawned command: `ANIDL_URL`, `ANIDL_OUTDIR`, `ANIDL_KIND`, `ANIDL_FORMAT`, `ANIDL_QUALITY`
  - AniDL CLI usually downloads by service + IDs (`--service`, `-s`, `-e`), so in many setups `ANIDL_CMD_TEMPLATE` should call your own wrapper script that maps URL -> AniDL args.
  - The command must download media into `{outdir}`. If output format does not match (`mp3|m4a|mp4`), backend tries ffmpeg conversion.
  - Render deployment now ships a default wrapper: `bin/anidl-render-wrapper.sh`
    - Auto template (if unset): `ANIDL_CMD_TEMPLATE="$APP_DIR/bin/anidl-render-wrapper.sh {url} {outdir} {kind} {format} {quality}"`
    - Wrapper defaults:
      - `ANIDL_ENTRY=$APP_DIR/vendor/multi-downloader-nx/lib/index.js`
      - `ANIDL_SHARED_HOME=$APP_DIR/.anidl-home`
    - Optional auth envs used by wrapper:
      - `ANIDL_USERNAME`, `ANIDL_PASSWORD`
      - `ANIDL_TOKEN` (Crunchyroll)
    - Optional ID overrides if URL parsing is not enough:
      - `ANIDL_FORCE_SERVICE`, `ANIDL_FORCE_S`, `ANIDL_FORCE_E`, `ANIDL_FORCE_EXTID`, `ANIDL_FORCE_SERIES`

Karaoke separation quality

- By default, karaoke separation now tries a Demucs pipeline first (StemRoller-style) and falls back to ffmpeg center-cancel only if Demucs is unavailable/fails.
- Recommended setup:
  - Install Demucs in the server environment (example): `pip install demucs`
  - Keep ffmpeg available in PATH.
- Optional env vars:
  - `KARAOKE_DEMUCS_ENABLED=1` (default `1`)
  - `KARAOKE_DEMUCS_MODEL=htdemucs` (balanced speed/quality model tag)
  - `KARAOKE_DEMUCS_CMD="python3 -m demucs.separate -n {model} --two-stems=vocals --device cpu --shifts 2 --segment 7 --overlap 0.25 -o {outdir} {input}"`
  - `KARAOKE_DEMUCS_STRICT=0` (default `0`; set `1` if you do not want ffmpeg fallback quality)
  - `KARAOKE_SEPARATION_TIMEOUT_MS=900000` (default 15 min; general separation timeout)
  - `KARAOKE_SEPARATION_IDLE_TIMEOUT_MS=120000` (default 2 min; aborts only if the separator stops emitting output)
  - `KARAOKE_INSTRUMENTAL_TTL_MS=600000` (default 10 min; auto-elimina el archivo instrumental generado en backend)
  - Demucs uses a protected timeout floor of 30 min to avoid cutting long CPU separations mid-progress.
  - `KARAOKE_SEPARATION_CMD=...` (highest priority custom command; overrides built-in Demucs command)

Render deployment notes

- Added:
  - `render-build.sh` (build Node app and mandatory Demucs install)
  - `render-start.sh` (auto-configures local Demucs command if venv exists)
  - `render.yaml` (blueprint defaults)
- Default behavior now installs Demucs during build.
- To keep Demucs active at runtime:
  1. set `KARAOKE_DEMUCS_ENABLED=1`
  2. redeploy (build can take significantly longer)
- Demucs build policy:
  - `INSTALL_DEMUCS=1` and `DEMUCS_STRICT_BUILD=1` forces build to fail if Demucs cannot be installed.
  - Build script now tries to auto-provision Python 3.11 via `uv` when system Python is incompatible.

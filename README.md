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

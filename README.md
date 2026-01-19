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

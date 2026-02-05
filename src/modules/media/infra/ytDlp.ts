import fs from 'fs';
import path from 'path';

let cachedPath: string | null = null;
let pending: Promise<string> | null = null;

export async function getYtDlpPath(): Promise<string> {
  if (process.env.YTDLP_PATH?.trim()) {
    return process.env.YTDLP_PATH.trim();
  }

  if (cachedPath) return cachedPath;
  if (pending) return pending;

  const binDir = path.join(process.cwd(), 'tmp');
  const binPath = path.join(binDir, 'yt-dlp');

  pending = (async () => {
    await fs.promises.mkdir(binDir, { recursive: true });

    if (!fs.existsSync(binPath)) {
      const mod: any = await import('yt-dlp-wrap');
      const YTDlpWrap = mod?.default ?? mod;

      if (!YTDlpWrap?.downloadFromGithub) {
        throw new Error('yt-dlp-wrap missing downloadFromGithub');
      }

      await YTDlpWrap.downloadFromGithub(binPath);
    }

    cachedPath = binPath;
    return binPath;
  })();

  return pending;
}

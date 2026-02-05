import fs from 'fs';
import path from 'path';
import https from 'https';

let cachedPath: string | null = null;
let pending: Promise<string> | null = null;

function downloadFile(url: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadFile(res.headers.location, filePath));
      }

      if (status !== 200) {
        res.resume();
        return reject(new Error(`Failed to download yt-dlp (status ${status})`));
      }

      const file = fs.createWriteStream(filePath, { mode: 0o755 });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    }).on('error', reject);
  });
}

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
      const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
      await downloadFile(url, binPath);
      await fs.promises.chmod(binPath, 0o755);
    }

    cachedPath = binPath;
    return binPath;
  })();

  return pending;
}

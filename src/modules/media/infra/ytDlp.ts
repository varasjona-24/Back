import fs from 'fs';
import path from 'path';
import https from 'https';

let cachedPath: string | null = null;
let pending: Promise<string> | null = null;
let cachedCookiesPath: string | null = null;

function getCookiesPath(): string {
  const envPath = process.env.YTDLP_COOKIES_PATH?.trim();
  if (envPath) return envPath;
  return path.join(process.cwd(), 'tmp', 'yt-cookies.txt');
}

export async function storeYtDlpCookies(content: string): Promise<string> {
  const cookiesPath = getCookiesPath();
  await fs.promises.mkdir(path.dirname(cookiesPath), { recursive: true });
  await fs.promises.writeFile(cookiesPath, content, 'utf-8');
  cachedCookiesPath = cookiesPath;
  return cookiesPath;
}

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

  const binDir = path.join(process.cwd(), 'bin');
  const binPath = path.join(binDir, 'yt-dlp');

  if (fs.existsSync(binPath)) {
    cachedPath = binPath;
    return binPath;
  }

  pending = (async () => {
    const tmpDir = path.join(process.cwd(), 'tmp');
    const tmpPath = path.join(tmpDir, 'yt-dlp');
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    await downloadFile(url, tmpPath);
    await fs.promises.chmod(tmpPath, 0o755);

    cachedPath = tmpPath;
    return tmpPath;
  })();

  return pending;
}

export async function getYtDlpExtraArgs(): Promise<string[]> {
  const args: string[] = ['--js-runtimes', 'node'];

  const cookiesPath = getCookiesPath();
  if (fs.existsSync(cookiesPath)) {
    cachedCookiesPath = cookiesPath;
    args.push('--cookies', cookiesPath);
    return args;
  }

  if (cachedCookiesPath && fs.existsSync(cachedCookiesPath)) {
    args.push('--cookies', cachedCookiesPath);
    return args;
  }

  const cookiesB64 = process.env.YTDLP_COOKIES_BASE64?.trim();
  if (!cookiesB64) return args;

  if (!cachedCookiesPath) {
    const decoded = Buffer.from(cookiesB64, 'base64').toString('utf-8');
    const savedPath = await storeYtDlpCookies(decoded);
    args.push('--cookies', savedPath);
    return args;
  }

  args.push('--cookies', cachedCookiesPath);
  return args;
}

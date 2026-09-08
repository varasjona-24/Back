import fs from 'fs';
import path from 'path';
import https from 'https';
import { spawn } from 'child_process';

let cachedPath: string | null = null;
let pending: Promise<string> | null = null;
let cachedCookiesPath: string | null = null;
let managedBinaryUpdate: Promise<void> | null = null;
let managedBinaryWasChecked = false;

function getCookiesPath(): string {
  const envPath = process.env.YTDLP_COOKIES_PATH?.trim();
  if (envPath) return envPath;

  const defaultPath = path.join(process.cwd(), 'tmp', 'yt-cookies.txt');
  if (fs.existsSync(defaultPath)) return defaultPath;

  const legacyPath = path.join(process.cwd(), 'www.youtube.com_cookies.txt');
  if (fs.existsSync(legacyPath)) return legacyPath;

  return defaultPath;
}

function getPotProviderUrl(): string | null {
  const enabled = process.env.YTDLP_POT_PROVIDER_ENABLED?.trim() ?? '1';
  if (enabled !== '1') {
    return null;
  }
  const configured = process.env.YTDLP_POT_PROVIDER_URL?.trim();
  return configured || null;
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

function shouldAutoUpdateManagedBinary(): boolean {
  return process.env.YTDLP_AUTO_UPDATE?.trim().toLowerCase() !== 'false';
}

async function updateManagedBinaryOnce(binaryPath: string): Promise<void> {
  if (!shouldAutoUpdateManagedBinary() || managedBinaryWasChecked) return;
  if (managedBinaryUpdate) return managedBinaryUpdate;

  managedBinaryUpdate = new Promise<void>((resolve) => {
    const child = spawn(binaryPath, ['-U'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, 45_000);

    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      console.warn('[yt-dlp] Automatic update could not start:', error.message);
      resolve();
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        console.info(`[yt-dlp] ${output.trim() || 'Update check completed.'}`);
      } else {
        console.warn(
          `[yt-dlp] Automatic update failed (exit ${code ?? 'unknown'}); using the existing binary. ${output.trim()}`,
        );
      }
      resolve();
    });
  }).finally(() => {
    managedBinaryWasChecked = true;
    managedBinaryUpdate = null;
  });

  return managedBinaryUpdate;
}

export async function getYtDlpPath(): Promise<string> {
  if (process.env.YTDLP_PATH?.trim()) {
    return process.env.YTDLP_PATH.trim();
  }

  if (cachedPath) {
    if (managedBinaryUpdate) await managedBinaryUpdate;
    return cachedPath;
  }
  if (pending) return pending;

  const binDir = path.join(process.cwd(), 'bin');
  const binPath = path.join(binDir, 'yt-dlp');

  if (fs.existsSync(binPath)) {
    cachedPath = binPath;
    await updateManagedBinaryOnce(binPath);
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
    managedBinaryWasChecked = true;
    return tmpPath;
  })();

  return pending;
}

export async function getYtDlpExtraArgs(): Promise<string[]> {
  const args: string[] = ['--js-runtimes', 'node'];
  const potProviderUrl = getPotProviderUrl();
  const pluginDir = path.join(process.cwd(), 'bin', 'yt-dlp-plugins');
  const pluginPath = path.join(pluginDir, 'bgutil-ytdlp-pot-provider.zip');

  if (potProviderUrl && fs.existsSync(pluginPath)) {
    args.push(
      '--plugin-dirs',
      pluginDir,
      '--extractor-args',
      `youtubepot-bgutilhttp:base_url=${potProviderUrl}`,
      '--extractor-args',
      'youtube:player_client=mweb,default',
    );
  }

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

import fs from 'fs';
import path from 'path';
import https from 'https';
import { spawn } from 'child_process';

const binDir = path.join(process.cwd(), 'bin');
const binPath = path.join(binDir, 'yt-dlp');
const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

function downloadFile(fileUrl, filePath) {
  return new Promise((resolve, reject) => {
    https.get(fileUrl, (res) => {
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

function printVersion() {
  return new Promise((resolve) => {
    const proc = spawn(binPath, ['--version']);

    proc.stdout.on('data', (data) => {
      console.log(`[yt-dlp] version: ${data.toString().trim()}`);
    });

    proc.stderr.on('data', (data) => {
      console.error(`[yt-dlp] stderr: ${data.toString()}`);
    });

    proc.on('close', () => resolve());
  });
}

async function main() {
  try {
    await fs.promises.mkdir(binDir, { recursive: true });

    if (fs.existsSync(binPath)) {
      console.log('[yt-dlp] Removing old binary...');
      await fs.promises.unlink(binPath);
    }

    console.log('[yt-dlp] Downloading latest version...');
    await downloadFile(url, binPath);

    await fs.promises.chmod(binPath, 0o755);

    console.log('[yt-dlp] Download complete');

    await printVersion();

  } catch (err) {
    console.error('[download-ytdlp] failed', err);
    process.exit(1);
  }
}

main();
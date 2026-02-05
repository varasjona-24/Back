import fs from 'fs';
import path from 'path';
import https from 'https';

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

async function main() {
  await fs.promises.mkdir(binDir, { recursive: true });

  if (fs.existsSync(binPath)) {
    return;
  }

  await downloadFile(url, binPath);
  await fs.promises.chmod(binPath, 0o755);
}

main().catch((err) => {
  console.error('[download-ytdlp] failed', err);
  process.exit(1);
});

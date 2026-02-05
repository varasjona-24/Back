import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import type {
  VideoSource,
  ResolvedMediaStream,
  DownloadQuality,
} from '../../domain/usecases/types.js';
import { getYtDlpPath } from '../ytDlp.js';

function ensureDir(pth: string) {
  return fs.promises.mkdir(pth, { recursive: true });
}

function unlinkQuiet(pth?: string) {
  if (!pth) return;
  fs.promises.unlink(pth).catch(() => {});
}

function run(cmd: string, args: string[], opts?: { timeoutMs?: number }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    const timeoutMs = opts?.timeoutMs ?? 0;
    let t: NodeJS.Timeout | null = null;

    if (timeoutMs > 0) {
      t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`${cmd} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (t) clearTimeout(t);
      reject(err);
    });

    child.on('close', (code) => {
      if (t) clearTimeout(t);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

export class GenericVideoSource implements VideoSource {
  canHandle(_url: string): boolean {
    // fallback total
    return true;
  }

  async getVideoStream(
    url: string,
    _range?: string,
    quality: DownloadQuality = 'high'
  ): Promise<ResolvedMediaStream> {
    const tmpDir = path.resolve('tmp');
    await ensureDir(tmpDir);

    const tmpFile = path.join(tmpDir, `${Date.now()}-generic-video.mp4`);

    // 1) Intentar con yt-dlp
    try {
      const ytDlpPath = await getYtDlpPath();
      const format = this.buildFormat(quality);
      const ytdlpArgs = [
        '--no-playlist',
        '-f', format,
        '--merge-output-format', 'mp4',
        '-o', tmpFile,
        url,
      ];

      const { code, stderr } = await run(ytDlpPath, ytdlpArgs, { timeoutMs: 1000 * 60 * 8 });

      if (code === 0 && fs.existsSync(tmpFile)) {
        return {
          stream: fs.createReadStream(tmpFile),
          mimeType: 'video/mp4',
          tmpFilePath: tmpFile,
        };
      }

      // si falló, seguimos a ffmpeg
      // guardamos stderr por si queremos loguearlo
      // console.error('[GenericVideoSource] yt-dlp failed:', stderr);
    } catch (e) {
      // yt-dlp no está, o se cayó; intentamos ffmpeg igual
      // console.error('[GenericVideoSource] yt-dlp error:', e);
    }

    // 2) Fallback: ffmpeg (sirve si es mp4 directo / m3u8 / dash sin restricciones)
    try {
      // -c copy: no recodifica
      // -movflags +faststart: ayuda a reproducir antes
      const ffArgs = [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-i', url,
        '-c', 'copy',
        '-movflags', '+faststart',
        tmpFile,
      ];

      const { code, stderr } = await run('ffmpeg', ffArgs, { timeoutMs: 1000 * 60 * 8 });

      if (code === 0 && fs.existsSync(tmpFile)) {
        const stat = fs.statSync(tmpFile);
        if (stat.size > 0) {
          return {
            stream: fs.createReadStream(tmpFile),
            mimeType: 'video/mp4',
            tmpFilePath: tmpFile,
          };
        }
      }

      throw new Error(`ffmpeg failed (code=${code}) ${stderr ? `: ${stderr}` : ''}`);
    } catch (e) {
      // si ffmpeg también falla, limpiamos y reportamos “restricción”
      unlinkQuiet(tmpFile);

      const msg =
        `No se pudo descargar el video. ` +
        `Posibles causas: el sitio bloquea descargas directas, requiere headers/cookies, ` +
        `o el stream está protegido/DRM.`;

      // opcional: añade detalle técnico al log del servidor
      // console.error('[GenericVideoSource] ffmpeg fallback failed:', e);

      throw new Error(msg);
    }
  }

  private buildFormat(quality: DownloadQuality): string {
    switch (quality) {
      case 'low':
        return 'bv*[height<=360]+ba/b[height<=360]';
      case 'medium':
        return 'bv*[height<=720]+ba/b[height<=720]';
      case 'high':
      default:
        return 'bv*+ba/b';
    }
  }
}

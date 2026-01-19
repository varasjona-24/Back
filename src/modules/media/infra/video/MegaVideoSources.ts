import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import type {
  VideoSource,
  ResolvedMediaStream
} from '../../domain/usecases/types.js';

function runMegadl(
  args: string[],
  timeoutMs = 1000 * 60 * 10 // ⏱️ 10 minutos
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('megadl', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';

    child.stderr.on('data', d => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      reject(new Error('MEGA download timeout'));
    }, timeoutMs);

    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', code => {
      clearTimeout(timer);

      if (code !== 0) {
        return reject(
          new Error(
            `MEGA download failed (code=${code})${
              stderr ? ` :: ${stderr.trim()}` : ''
            }`
          )
        );
      }

      resolve();
    });
  });
}

export class MegaVideoSource implements VideoSource {
  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('mega.nz/') || u.includes('mega.co.nz/');
  }

  async getVideoStream(url: string): Promise<ResolvedMediaStream> {
    // 📁 tmp único por descarga
    const tmpDir = path.resolve(
      'tmp',
      `mega-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );

    await fs.promises.mkdir(tmpDir, { recursive: true });

    // ⬇️ descargar
    await runMegadl([
      '--path',
      tmpDir,
      '--no-progress',
      url,
    ]);

    // 🔍 buscar archivos descargados
    const files = (await fs.promises.readdir(tmpDir))
      .map(name => path.join(tmpDir, name))
      .filter(p => {
        try {
          return fs.statSync(p).isFile();
        } catch {
          return false;
        }
      });

    if (files.length === 0) {
      throw new Error('MEGA download finished but no files were found');
    }

    // 🧠 elegir el archivo más reciente (MEGA carpetas / varios archivos)
    files.sort(
      (a, b) =>
        fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
    );

    const pickedFile = files[0];

    // 🛡️ validar tamaño
    const size = fs.statSync(pickedFile).size;
    if (size <= 0) {
      throw new Error('Downloaded MEGA file is empty');
    }

    return {
      stream: fs.createReadStream(pickedFile),
      mimeType: 'video/mp4', // ⚠️ si luego quieres detectar por extensión, se puede
      tmpFilePath: pickedFile,
    };
  }
}

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import type {
  AudioSource,
  AudioFormat,
  ResolvedMediaStream,
  DownloadQuality,
} from '../../domain/usecases/types.js';

function runProcess(
  command: string,
  args: string[],
  timeoutMs = 1000 * 60 * 10
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      reject(new Error(`${command} timeout`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        return reject(
          new Error(
            `${command} failed (code=${code})${
              stderr ? ` :: ${stderr.trim()}` : ''
            }`
          )
        );
      }

      resolve();
    });
  });
}

function isAudioExtension(ext: string): boolean {
  return ['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus'].includes(
    ext
  );
}

export class MegaAudioSource implements AudioSource {
  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('mega.nz/') || u.includes('mega.co.nz/');
  }

  async getAudioStream(
    url: string,
    _range?: string,
    format: AudioFormat = 'm4a',
    _quality?: DownloadQuality
  ): Promise<ResolvedMediaStream> {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tmpDir = path.resolve('tmp', `mega-audio-${token}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });

    await runProcess('megadl', ['--path', tmpDir, '--no-progress', url]);

    const files = (await fs.promises.readdir(tmpDir))
      .map((name) => path.join(tmpDir, name))
      .filter((p) => {
        try {
          return fs.statSync(p).isFile();
        } catch {
          return false;
        }
      });

    if (files.length === 0) {
      throw new Error('MEGA audio download finished but no files were found');
    }

    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    const pickedFile = files[0];
    const pickedExt = path.extname(pickedFile).toLowerCase();

    const outFile = path.join(tmpDir, `${token}.${format}`);
    const shouldConvert =
      pickedExt !== `.${format}` || !isAudioExtension(pickedExt);

    const finalFile = shouldConvert ? outFile : pickedFile;

    if (shouldConvert) {
      await runProcess('ffmpeg', [
        '-y',
        '-i',
        pickedFile,
        '-vn',
        '-c:a',
        format === 'mp3' ? 'libmp3lame' : 'aac',
        outFile,
      ]);
    }

    const size = fs.statSync(finalFile).size;
    if (size <= 0) {
      throw new Error('Downloaded MEGA audio file is empty');
    }

    return {
      stream: fs.createReadStream(finalFile),
      mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/mp4',
      tmpFilePath: finalFile,
    };
  }
}

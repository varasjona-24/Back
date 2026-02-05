import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import type {
  AudioSource,
  ResolvedMediaStream,
  DownloadQuality,
} from '../../domain/usecases/types.js';
import { getYtDlpPath } from '../ytDlp.js';

export class GenericAudioSource implements AudioSource {

  canHandle(_url: string): boolean {
    return true;
  }

  async getAudioStream(
    url: string,
    _range?: string,
    _format?: unknown,
    _quality?: DownloadQuality
  ): Promise<ResolvedMediaStream> {
    const tmpDir = path.join(process.cwd(), 'tmp');
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const tmpFilePath = path.join(
      tmpDir,
      `${Date.now()}-generic-audio.tmp`
    );
    const ytDlpPath = await getYtDlpPath();

    return new Promise((resolve, reject) => {
      const child = spawn(ytDlpPath, [
        '--no-playlist',
        '-f', 'ba',
        '-o', tmpFilePath,
        url
      ]);

      let stderr = '';
      child.stderr?.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('close', code => {
        if (code !== 0) {
          const detail = stderr.trim();
          return reject(
            new Error(
              detail
                ? `yt-dlp failed to download audio: ${detail}`
                : 'yt-dlp failed to download audio'
            )
          );
        }

        resolve({
          stream: fs.createReadStream(tmpFilePath),
          mimeType: 'audio/mp4',
          tmpFilePath
        });
      });

      child.on('error', reject);
    });
  }
}

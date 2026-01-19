import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import type { VideoSource, ResolvedMediaStream } from '../../domain/usecases/types.js';

export class GenericVideoSource implements VideoSource {

  canHandle(_url: string): boolean {
    // ⚠️ fallback total (siempre true)
    return true;
  }

  async getVideoStream(url: string): Promise<ResolvedMediaStream> {
    const tmpDir = path.resolve('tmp');
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const tmpFile = path.join(
      tmpDir,
      `${Date.now()}-generic-video.mp4`
    );

    return new Promise((resolve, reject) => {
      const child = spawn('yt-dlp', [
        '-f', 'bv*+ba/b',
        '--merge-output-format', 'mp4',
        '-o', tmpFile,
        url
      ]);

      child.on('close', code => {
        if (code !== 0) {
          return reject(new Error('yt-dlp failed to download video'));
        }

      return {
  stream: fs.createReadStream(tmpFile),
  mimeType: 'video/mp4',
  tmpFilePath: tmpFile // ✅
};
      });
    });
  }
}

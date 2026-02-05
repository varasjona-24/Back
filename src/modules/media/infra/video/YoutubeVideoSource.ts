import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  VideoSource,
  ResolvedMediaStream,
  DownloadQuality,
} from '../../domain/usecases/types.js';
import { getYtDlpPath } from '../ytDlp.js';

export class YoutubeVideoSource implements VideoSource {

  canHandle(url: string): boolean {
    return /youtube\.com|youtu\.be/.test(url);
  }

  async getVideoStream(
    url: string,
    _range?: string,
    quality: DownloadQuality = 'high'
  ): Promise<ResolvedMediaStream> {

    const tmpDir = path.resolve('tmp');
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const tmpFile = path.join(
      tmpDir,
      `${Date.now()}-video.mp4`
    );

    const maxHeight = this.mapQuality(quality);
    const format = `bestvideo[ext=mp4][vcodec^=avc1][height<=${maxHeight}]+bestaudio[ext=m4a]/best[ext=mp4]`;

    const ytDlpPath = await getYtDlpPath();
    const child = spawn(ytDlpPath, [
      '-f', format,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '-o', tmpFile,
      url
    ], {
      stdio: ['ignore', 'inherit', 'inherit']
    });

    await new Promise<void>((resolve, reject) => {
      child.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp exited with code ${code}`));
      });
    });

   return {
  stream: fs.createReadStream(tmpFile),
  mimeType: 'video/mp4',
  tmpFilePath: tmpFile // ✅
};

  }

  private mapQuality(quality: DownloadQuality): number {
    switch (quality) {
      case 'low':
        return 360;
      case 'medium':
        return 720;
      case 'high':
      default:
        return 1080;
    }
  }
}

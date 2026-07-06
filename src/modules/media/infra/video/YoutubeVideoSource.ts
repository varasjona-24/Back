import { spawn } from 'child_process';
import fs from 'fs';
import {
  VideoSource,
  ResolvedMediaStream,
  DownloadQuality,
} from '../../domain/usecases/types.js';
import { getYtDlpExtraArgs, getYtDlpPath } from '../ytDlp.js';
import {
  cleanupFile,
  ensureDirForFile,
  randomTmpFilePath,
} from '../../../../shared/fsSafety.js';

export class YoutubeVideoSource implements VideoSource {

  canHandle(url: string): boolean {
    return /youtube\.com|youtu\.be/.test(url);
  }

  async getVideoStream(
    url: string,
    _range?: string,
    quality: DownloadQuality = 'high'
  ): Promise<ResolvedMediaStream> {

    const tmpFile = randomTmpFilePath('youtube-video', 'mp4');
    await ensureDirForFile(tmpFile);

    const maxHeight = this.mapQuality(quality);
    const format = [
      `bestvideo[ext=mp4][vcodec^=avc1][height<=${maxHeight}][dynamic_range=SDR]+bestaudio[ext=m4a]`,
      `best[ext=mp4][vcodec^=avc1][height<=${maxHeight}][dynamic_range=SDR]`,
      `bestvideo[ext=mp4][vcodec^=avc1][height<=${maxHeight}]+bestaudio[ext=m4a]`,
      `best[ext=mp4][vcodec^=avc1][height<=${maxHeight}]`,
    ].join('/');

    const ytDlpPath = await getYtDlpPath();
    const extraArgs = await getYtDlpExtraArgs();
    const child = spawn(ytDlpPath, [
      ...extraArgs,
      '-f', format,
      '--merge-output-format', 'mp4',
      '--postprocessor-args', 'Merger+ffmpeg:-movflags +faststart',
      '--no-playlist',
      '-o', tmpFile,
      url
    ], {
      stdio: ['ignore', 'inherit', 'inherit']
    });

    try {
      await new Promise<void>((resolve, reject) => {
        child.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(`yt-dlp exited with code ${code}`));
        });
        child.on('error', reject);
      });
    } catch (error) {
      await cleanupFile(tmpFile);
      throw error;
    }

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

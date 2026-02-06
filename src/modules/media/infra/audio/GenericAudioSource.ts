import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import type {
  AudioSource,
  AudioFormat,
  ResolvedMediaStream,
  DownloadQuality,
} from '../../domain/usecases/types.js';
import { getYtDlpExtraArgs, getYtDlpPath } from '../ytDlp.js';

export class GenericAudioSource implements AudioSource {

  canHandle(_url: string): boolean {
    return true;
  }

  async getAudioStream(
    url: string,
    _range?: string,
    format: AudioFormat = 'm4a',
    quality: DownloadQuality = 'high'
  ): Promise<ResolvedMediaStream> {
    const tmpDir = path.join(process.cwd(), 'tmp');
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const tmpFilePath = path.join(
      tmpDir,
      `${Date.now()}-generic-audio.${format}`
    );
    const ytDlpPath = await getYtDlpPath();
    const extraArgs = await getYtDlpExtraArgs();
    const audioQuality = this.mapQuality(quality);
    const audioBitrate = this.mapBitrate(quality);

    return new Promise((resolve, reject) => {
      const child = spawn(ytDlpPath, [
        ...extraArgs,
        '--no-playlist',
        '-x',
        '--audio-format', format,
        '--audio-quality', audioQuality,
        '--postprocessor-args', `ffmpeg:-b:a ${audioBitrate}`,
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
          mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/mp4',
          tmpFilePath
        });
      });

      child.on('error', reject);
    });
  }

  private mapQuality(quality: DownloadQuality): string {
    switch (quality) {
      case 'low':
        return '5';
      case 'medium':
        return '3';
      case 'high':
      default:
        return '0';
    }
  }

  private mapBitrate(quality: DownloadQuality): string {
    switch (quality) {
      case 'low':
        return '128k';
      case 'medium':
        return '192k';
      case 'high':
      default:
        return '320k';
    }
  }
}

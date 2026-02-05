import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
//import { Readable } from 'stream';
import {
  AudioSource,
  //ResolvedAudio,
  AudioFormat,
  ResolvedMediaStream,
  DownloadQuality
} from '../../domain/usecases/types.js';
import { getYtDlpPath } from '../ytDlp.js';

export class YoutubeAudioSource implements AudioSource {

  canHandle(url: string): boolean {
    return /youtube\.com|youtu\.be/.test(url);
  }

  /**
   * Obtiene un stream de audio desde YouTube.
   * - Por defecto devuelve MP3 (ideal para móvil)
   * - Compatible con streaming y descarga
   */
 async getAudioStream(
  url: string,
  _range?: string,
  format: AudioFormat = 'm4a',
  quality: DownloadQuality = 'high'
 ): Promise<ResolvedMediaStream> {
  const tmpDir = path.join(process.cwd(), 'tmp');
  await fs.promises.mkdir(tmpDir, { recursive: true });

  const tmpFilePath = path.join(tmpDir, `${Date.now()}-generic-audio.${format}`);

  const audioQuality = this.mapQuality(quality);
  const ytDlpPath = await getYtDlpPath();

  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpPath, [
      '-x',
      '--no-playlist',
      '--audio-format', format,
      '--audio-quality', audioQuality,
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


  /* ======================================================
   * Helpers privados
   * ====================================================== */

  private buildArgs(url: string, format: AudioFormat): string[] {
    const baseArgs = [
      '--no-playlist',
      '-o', '-' // stdout
    ];

    if (format === 'mp3' || format === 'm4a') {
      return [
        '-x',
        '--audio-format', format,
        '--audio-quality', '0',
        ...baseArgs,
        url
      ];
    }

    // fallback (no debería ocurrir)
    return [
      '-f', 'bestaudio',
      ...baseArgs,
      url
    ];
  }

  private getMimeType(format: AudioFormat): string {
    switch (format) {
      case 'mp3':
        return 'audio/mpeg';
      case 'm4a':
        return 'audio/mp4';
      default:
        return 'application/octet-stream';
    }
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
}

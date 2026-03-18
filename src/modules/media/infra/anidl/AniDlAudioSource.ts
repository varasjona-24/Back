import fs from 'fs';

import type {
  AudioFormat,
  AudioSource,
  DownloadQuality,
  ResolvedMediaStream,
} from '../../domain/usecases/types.js';
import {
  canHandleAniDlUrl,
  isAniDlEnabled,
  runAniDlDownload,
} from './AniDlRunner.js';

export class AniDlAudioSource implements AudioSource {
  canHandle(url: string): boolean {
    return isAniDlEnabled() && canHandleAniDlUrl(url);
  }

  async getAudioStream(
    url: string,
    _range?: string,
    format: AudioFormat = 'm4a',
    quality: DownloadQuality = 'high'
  ): Promise<ResolvedMediaStream> {
    const filePath = await runAniDlDownload({
      url,
      kind: 'audio',
      format,
      quality,
    });

    return {
      stream: fs.createReadStream(filePath),
      mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/mp4',
      tmpFilePath: filePath,
    };
  }
}

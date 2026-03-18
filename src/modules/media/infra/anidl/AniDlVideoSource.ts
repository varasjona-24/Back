import fs from 'fs';

import type {
  DownloadQuality,
  ResolvedMediaStream,
  VideoSource,
} from '../../domain/usecases/types.js';
import {
  canHandleAniDlUrl,
  isAniDlEnabled,
  runAniDlDownload,
} from './AniDlRunner.js';

export class AniDlVideoSource implements VideoSource {
  canHandle(url: string): boolean {
    return isAniDlEnabled() && canHandleAniDlUrl(url);
  }

  async getVideoStream(
    url: string,
    _range?: string,
    quality: DownloadQuality = 'high'
  ): Promise<ResolvedMediaStream> {
    const filePath = await runAniDlDownload({
      url,
      kind: 'video',
      format: 'mp4',
      quality,
    });

    return {
      stream: fs.createReadStream(filePath),
      mimeType: 'video/mp4',
      tmpFilePath: filePath,
    };
  }
}

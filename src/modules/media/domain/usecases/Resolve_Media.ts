import type { AudioSource, ResolvedAudio } from './types.js';
import { parseSafeMediaUrl } from '../../../../shared/urlSafety.js';

export class ResolveMedia {
  constructor(
    private readonly sources: AudioSource[]
  ) {}

  async execute(
    url: string,
    rangeHeader?: string
  ): Promise<ResolvedAudio> {

    parseSafeMediaUrl(url);

    const source = this.sources.find(s => s.canHandle(url));

    if (!source) {
      throw new Error('No supported audio source');
    }

    return source.getAudioStream(url, rangeHeader);
  }

}

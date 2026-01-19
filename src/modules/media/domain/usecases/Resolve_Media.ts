import type { AudioSource, ResolvedAudio } from './types.js';

export class ResolveMedia {
  constructor(
    private readonly sources: AudioSource[]
  ) {}

  async execute(
    url: string,
    rangeHeader?: string
  ): Promise<ResolvedAudio> {

    if (!this.isValidUrl(url)) {
      throw new Error('Invalid URL');
    }

    const source = this.sources.find(s => s.canHandle(url));

    if (!source) {
      throw new Error('No supported audio source');
    }

    return source.getAudioStream(url, rangeHeader);
  }

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }
}

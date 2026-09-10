type MusicBrainzRecordingResponse = {
  recordings?: Array<Record<string, unknown>>;
};

/**
 * MusicBrainz asks clients to stay below one request per second. Keeping the
 * queue process-local makes every mobile device share the same compliant,
 * server-side identity without retaining any lookup data.
 */
export class MusicBrainzMetadataSearchSource {
  private static readonly endpoint = 'https://musicbrainz.org/ws/2/recording/';
  private static readonly minimumRequestGapMs = 1_100;
  private static readonly retryDelaysMs = [1_500, 3_000];
  private static queue: Promise<unknown> = Promise.resolve();
  private static lastRequestAt = 0;

  async search({
    title,
    artist,
    limit = 10,
  }: {
    title: string;
    artist: string;
    limit?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const run = MusicBrainzMetadataSearchSource.queue.then(() =>
      this.requestWithRetry({ title, artist, limit }),
    );
    MusicBrainzMetadataSearchSource.queue = run.catch(() => undefined);
    return run;
  }

  private async requestWithRetry({
    title,
    artist,
    limit,
  }: {
    title: string;
    artist: string;
    limit: number;
  }): Promise<Array<Record<string, unknown>>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.request({ title, artist, limit });
      } catch (error) {
        if (!this.isRetryable(error) || attempt >= MusicBrainzMetadataSearchSource.retryDelaysMs.length) {
          throw error;
        }
        await this.sleep(MusicBrainzMetadataSearchSource.retryDelaysMs[attempt]);
      }
    }
  }

  private async request({
    title,
    artist,
    limit,
  }: {
    title: string;
    artist: string;
    limit: number;
  }): Promise<Array<Record<string, unknown>>> {
    const now = Date.now();
    const waitMs = Math.max(
      0,
      MusicBrainzMetadataSearchSource.lastRequestAt +
        MusicBrainzMetadataSearchSource.minimumRequestGapMs -
        now,
    );
    if (waitMs > 0) await this.sleep(waitMs);
    MusicBrainzMetadataSearchSource.lastRequestAt = Date.now();

    const url = new URL(MusicBrainzMetadataSearchSource.endpoint);
    const query = [
      `recording:${this.lucenePhrase(title)}`,
      artist ? `artistname:${this.lucenePhrase(artist)}` : '',
    ].filter(Boolean).join(' AND ');
    url.searchParams.set('query', query);
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('limit', String(Math.max(1, Math.min(10, limit))));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Listenfy/1.1.0 (https://github.com/varasjona-24/Lisenfy-MVP)',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new MusicBrainzSearchError(response.status);
      }
      const payload = await response.json() as MusicBrainzRecordingResponse;
      return Array.isArray(payload.recordings) ? payload.recordings : [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof MusicBrainzSearchError) {
      return [429, 502, 503, 504].includes(error.status);
    }
    return error instanceof Error && error.name === 'AbortError';
  }

  private lucenePhrase(value: string): string {
    return `"${value.replace(/[+\-!(){}\[\]^"~*?:\\\\/&|]/g, '\\$&')}"`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

class MusicBrainzSearchError extends Error {
  constructor(readonly status: number) {
    super(`MusicBrainz responded with HTTP ${status}.`);
  }
}

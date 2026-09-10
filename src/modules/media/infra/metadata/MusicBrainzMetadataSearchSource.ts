type MusicBrainzRecordingResponse = {
  recordings?: Array<Record<string, unknown>>;
};

type MusicBrainzArtistResponse = {
  area?: { 'iso-3166-1-codes'?: unknown };
  'begin-area'?: { 'iso-3166-1-codes'?: unknown };
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
    return this.enqueue(() =>
      this.requestWithRetry({ title, artist, limit }),
    );
  }

  async resolveArtistCountry(artistId: string): Promise<string | null> {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(artistId)) {
      return null;
    }
    return this.enqueue(() => this.requestArtistCountryWithRetry(artistId));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = MusicBrainzMetadataSearchSource.queue.then(operation);
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
    const url = new URL(MusicBrainzMetadataSearchSource.endpoint);
    const query = [
      `recording:${this.lucenePhrase(title)}`,
      artist ? `artistname:${this.lucenePhrase(artist)}` : '',
    ].filter(Boolean).join(' AND ');
    url.searchParams.set('query', query);
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('limit', String(Math.max(1, Math.min(10, limit))));
    const payload = await this.fetchJson<MusicBrainzRecordingResponse>(url);
    return Array.isArray(payload.recordings) ? payload.recordings : [];
  }

  private async requestArtistCountryWithRetry(artistId: string): Promise<string | null> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const url = new URL(
          `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(artistId)}`,
        );
        url.searchParams.set('fmt', 'json');
        const payload = await this.fetchJson<MusicBrainzArtistResponse>(url);
        return this.countryCodeFromArtist(payload);
      } catch (error) {
        if (!this.isRetryable(error) || attempt >= MusicBrainzMetadataSearchSource.retryDelaysMs.length) {
          throw error;
        }
        await this.sleep(MusicBrainzMetadataSearchSource.retryDelaysMs[attempt]);
      }
    }
  }

  private async fetchJson<T>(url: URL): Promise<T> {
    const now = Date.now();
    const waitMs = Math.max(
      0,
      MusicBrainzMetadataSearchSource.lastRequestAt +
        MusicBrainzMetadataSearchSource.minimumRequestGapMs -
        now,
    );
    if (waitMs > 0) await this.sleep(waitMs);
    MusicBrainzMetadataSearchSource.lastRequestAt = Date.now();

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
      return await response.json() as T;
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

  private countryCodeFromArtist(payload: MusicBrainzArtistResponse): string | null {
    const areas = [payload.area, payload['begin-area']];
    for (const area of areas) {
      const codes = area?.['iso-3166-1-codes'];
      if (!Array.isArray(codes)) continue;
      const code = codes.find(
        (value): value is string => typeof value === 'string' && /^[A-Z]{2}$/i.test(value),
      );
      if (code) return code.toUpperCase();
    }
    return null;
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

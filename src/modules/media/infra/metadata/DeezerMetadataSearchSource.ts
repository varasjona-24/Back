export type DeezerTrackCandidate = {
  id: number;
  title: string;
  artist: string;
  durationSeconds: number;
  rank: number;
};

type DeezerSearchResponse = {
  data?: Array<{
    id?: number;
    title?: string;
    duration?: number;
    rank?: number;
    artist?: { name?: string };
  }>;
};

/**
 * Reads Deezer's public track index only. Results are deliberately kept in
 * memory for the lifetime of a single metadata resolution.
 */
export class DeezerMetadataSearchSource {
  private static readonly baseUrl = 'https://api.deezer.com/search/track';
  private static readonly timeoutMs = 4_500;

  async search({
    title,
    artist,
  }: {
    title: string;
    artist: string;
  }): Promise<DeezerTrackCandidate[]> {
    const strictQuery = [
      `track:${this.quote(title)}`,
      artist ? `artist:${this.quote(artist)}` : '',
    ].filter(Boolean).join(' ');

    const strictResults = await this.request(strictQuery, true);

    // The broad query catches catalog aliases and minor spelling differences
    // that strict field matching can miss.
    const broadResults = await this.request(
      [title, artist].filter(Boolean).join(' '),
      false,
    );
    return [...strictResults, ...broadResults];
  }

  private async request(query: string, strict: boolean): Promise<DeezerTrackCandidate[]> {
    if (!query.trim()) return [];

    const url = new URL(DeezerMetadataSearchSource.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '10');
    if (strict) url.searchParams.set('strict', 'on');

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DeezerMetadataSearchSource.timeoutMs,
    );

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Listenfy/1.1.0 metadata resolver',
        },
        signal: controller.signal,
      });
      if (!response.ok) return [];

      const payload = await response.json() as DeezerSearchResponse;
      return (payload.data ?? [])
        .map((item) => ({
          id: Number(item.id ?? 0),
          title: item.title?.trim() ?? '',
          artist: item.artist?.name?.trim() ?? '',
          durationSeconds: Math.max(0, Math.round(Number(item.duration ?? 0))),
          rank: Math.max(0, Number(item.rank ?? 0)),
        }))
        .filter((item) => item.id > 0 && item.title && item.artist);
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private quote(value: string): string {
    return `"${value.replace(/"/g, ' ')}"`;
  }
}

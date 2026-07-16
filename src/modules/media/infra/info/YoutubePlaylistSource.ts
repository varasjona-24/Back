import { spawn } from 'child_process';
import { getYtDlpExtraArgs, getYtDlpPath } from '../ytDlp.js';
import { isYoutubeUrl, parseSafeMediaUrl } from '../../../../shared/urlSafety.js';

export interface YoutubePlaylistEntry {
  url: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
  index: number;
}

export interface YoutubePlaylistResolvedInfo {
  title: string;
  thumbnail: string | null;
  entries: YoutubePlaylistEntry[];
}

type RawYoutubePlaylistEntry = {
  id?: unknown;
  url?: unknown;
  webpage_url?: unknown;
  title?: unknown;
  uploader?: unknown;
  channel?: unknown;
  duration?: unknown;
  thumbnail?: unknown;
  thumbnails?: unknown;
  playlist_index?: unknown;
};

function pickThumbnail(raw: RawYoutubePlaylistEntry): string | null {
  const direct = typeof raw.thumbnail === 'string' ? raw.thumbnail.trim() : '';
  if (direct) return direct;

  if (!Array.isArray(raw.thumbnails)) return null;
  for (let i = raw.thumbnails.length - 1; i >= 0; i--) {
    const candidate = raw.thumbnails[i];
    if (!candidate || typeof candidate !== 'object') continue;
    const url = (candidate as { url?: unknown }).url;
    if (typeof url === 'string' && url.trim()) return url.trim();
  }
  return null;
}

function buildEntryUrl(raw: RawYoutubePlaylistEntry): string {
  const webpageUrl = typeof raw.webpage_url === 'string' ? raw.webpage_url.trim() : '';
  if (webpageUrl.startsWith('http://') || webpageUrl.startsWith('https://')) {
    return webpageUrl;
  }

  const directUrl = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (directUrl.startsWith('http://') || directUrl.startsWith('https://')) {
    return directUrl;
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : directUrl;
  if (!id) throw new Error('Playlist entry does not include a playable id');
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}

export class YoutubePlaylistSource {
  async resolve(url: string, maxItems: number): Promise<YoutubePlaylistResolvedInfo> {
    if (!isYoutubeUrl(url)) {
      throw new Error('YouTube playlist URL is required');
    }
    parseSafeMediaUrl(url);

    const safeMaxItems = Math.max(1, Math.min(100, Math.floor(maxItems)));
    const ytDlpPath = await getYtDlpPath();
    const extraArgs = await getYtDlpExtraArgs();

    return new Promise((resolve, reject) => {
      const child = spawn(ytDlpPath, [
        ...extraArgs,
        '--dump-single-json',
        '--flat-playlist',
        '--yes-playlist',
        '--playlist-end',
        String(safeMaxItems),
        url,
      ]);

      let data = '';
      let stderr = '';

      child.stdout.on('data', chunk => {
        data += chunk.toString();
      });

      child.stderr?.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('close', code => {
        try {
          if (code !== 0) {
            const detail = stderr.trim();
            return reject(
              new Error(
                detail
                  ? `yt-dlp failed to resolve playlist: ${detail}`
                  : 'yt-dlp failed to resolve playlist'
              )
            );
          }

          if (!data.trim()) {
            return reject(new Error('yt-dlp returned empty playlist info'));
          }

          const json = JSON.parse(data);
          const rawEntries = Array.isArray(json.entries) ? json.entries : [];
          const entries: YoutubePlaylistEntry[] = [];

          for (let i = 0; i < rawEntries.length; i++) {
            const raw = rawEntries[i] as RawYoutubePlaylistEntry;
            const entryUrl = buildEntryUrl(raw);
            const index = typeof raw.playlist_index === 'number'
              ? raw.playlist_index
              : i + 1;
            entries.push({
              url: entryUrl,
              title: typeof raw.title === 'string' && raw.title.trim()
                ? raw.title.trim()
                : `Track ${index}`,
              artist:
                (typeof raw.uploader === 'string' && raw.uploader.trim()) ||
                (typeof raw.channel === 'string' && raw.channel.trim()) ||
                'Unknown',
              duration: typeof raw.duration === 'number' && Number.isFinite(raw.duration)
                ? Math.max(0, raw.duration * 1000)
                : 0,
              thumbnail: pickThumbnail(raw),
              index,
            });
          }

          if (entries.length === 0) {
            return reject(new Error('Playlist has no readable entries'));
          }

          resolve({
            title: typeof json.title === 'string' && json.title.trim()
              ? json.title.trim()
              : 'YouTube playlist',
            thumbnail: typeof json.thumbnail === 'string' && json.thumbnail.trim()
              ? json.thumbnail.trim()
              : entries[0]?.thumbnail ?? null,
            entries,
          });
        } catch (err) {
          reject(err);
        }
      });

      child.on('error', reject);
    });
  }
}

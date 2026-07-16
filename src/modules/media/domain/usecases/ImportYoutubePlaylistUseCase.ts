import { v4 as uuid } from 'uuid';

import { mediaLibrary } from '../library/index.js';
import { normalizeMediaInfo } from '../utils/normalizeMedia.js';
import { DownloadMediaVariantUseCase } from './Download_Media_Variant_Use_Case.js';
import type {
  AudioFormat,
  DownloadQuality,
  MediaKind,
  NormalizedMediaInfo,
  VideoFormat,
} from './types.js';
import type { MediaLibrary } from '../library/MediasLibrary.js';
import { YoutubePlaylistSource } from '../../infra/info/YoutubePlaylistSource.js';
import type { YoutubePlaylistEntry } from '../../infra/info/YoutubePlaylistSource.js';
import { YoutubeAudioSource } from '../../infra/audio/YoutubeAudioSource.js';
import { YoutubeVideoSource } from '../../infra/video/YoutubeVideoSource.js';
import { playlistRepository } from '../../../playlist/infra/index.js';
import type { PlaylistRepository } from '../../../playlist/domain/PlaylistRepository.js';
import type { Playlist } from '../../../playlist/domain/Playlist.js';
import { parseSafeMediaUrl } from '../../../../shared/urlSafety.js';

export type ImportYoutubePlaylistInput = {
  url: string;
  kind: MediaKind;
  format: AudioFormat | VideoFormat;
  quality?: DownloadQuality;
  maxItems?: number;
  playlistName?: string;
  selectedUrls?: string[];
};

export type ImportedPlaylistItem = {
  mediaId: string;
  url: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
  index: number;
  variant: {
    kind: MediaKind;
    format: AudioFormat | VideoFormat;
    path: string;
  };
};

export type FailedPlaylistItem = {
  url: string;
  title: string;
  index: number;
  error: string;
};

export type ImportYoutubePlaylistResult = {
  playlist: Playlist;
  name: string;
  thumbnail: string | null;
  total: number;
  imported: number;
  failed: number;
  items: ImportedPlaylistItem[];
  failures: FailedPlaylistItem[];
};

export class ImportYoutubePlaylistUseCase {
  constructor(
    private readonly playlistSource = new YoutubePlaylistSource(),
    private readonly library: MediaLibrary = mediaLibrary,
    private readonly playlists: PlaylistRepository = playlistRepository,
    private readonly basePath: string = process.env.MEDIA_PATH || 'media',
    private readonly variantTtlMs: number = 30 * 60 * 1000
  ) {}

  async execute(input: ImportYoutubePlaylistInput): Promise<ImportYoutubePlaylistResult> {
    parseSafeMediaUrl(input.url);

    const maxItems = Math.max(1, Math.min(100, Math.floor(input.maxItems ?? 50)));
    const playlistInfo = await this.playlistSource.resolve(input.url, maxItems);
    const selectedUrlSet = new Set(
      (input.selectedUrls ?? [])
        .map(url => url.trim())
        .filter(url => url.length > 0)
    );
    const entries = selectedUrlSet.size > 0
      ? playlistInfo.entries.filter(entry => selectedUrlSet.has(entry.url))
      : playlistInfo.entries;

    if (entries.length === 0) {
      throw new Error('No selected playlist entries were found');
    }

    const playlist = this.playlists.create(
      input.playlistName?.trim() || playlistInfo.title
    );
    const downloader = this.createDownloader();
    const importedItems: ImportedPlaylistItem[] = [];
    const failures: FailedPlaylistItem[] = [];

    for (const entry of entries) {
      try {
        const media = this.ensureMedia(entry);
        const result = await downloader.execute({
          mediaId: media.id,
          url: entry.url,
          kind: input.kind,
          format: input.format,
          quality: input.quality,
        });

        this.playlists.addMedia(playlist.id, media.id);
        importedItems.push({
          mediaId: media.id,
          url: entry.url,
          title: media.title,
          artist: media.artist,
          duration: media.duration,
          thumbnail: media.thumbnail,
          index: entry.index,
          variant: {
            kind: result.kind,
            format: result.format,
            path: result.filePath,
          },
        });
      } catch (error) {
        failures.push({
          url: entry.url,
          title: entry.title,
          index: entry.index,
          error: error instanceof Error ? error.message : String(error ?? 'Unknown error'),
        });
      }
    }

    const updatedPlaylist = this.playlists.getById(playlist.id) ?? playlist;
    return {
      playlist: updatedPlaylist,
      name: updatedPlaylist.name,
      thumbnail: playlistInfo.thumbnail,
      total: entries.length,
      imported: importedItems.length,
      failed: failures.length,
      items: importedItems,
      failures,
    };
  }

  private createDownloader(): DownloadMediaVariantUseCase {
    return new DownloadMediaVariantUseCase(
      [new YoutubeAudioSource()],
      [new YoutubeVideoSource()],
      this.library,
      this.basePath,
      this.variantTtlMs
    );
  }

  private ensureMedia(entry: YoutubePlaylistEntry): NormalizedMediaInfo {
    const sourceId = Buffer.from(entry.url).toString('base64');
    const existing = this.library.getAll().find(media => media.sourceId === sourceId);
    if (existing) return existing;

    const normalized = normalizeMediaInfo({
      title: entry.title,
      artist: entry.artist,
    });

    const media: NormalizedMediaInfo = {
      id: uuid(),
      publicId: uuid(),
      source: 'youtube',
      sourceId,
      title: normalized.title,
      artist: normalized.artist,
      duration: entry.duration,
      thumbnail: entry.thumbnail,
      rawTitle: entry.title,
      rawArtist: entry.artist,
      extras: {
        ...normalized.extras,
        playlistIndex: entry.index,
        importedFromPlaylist: true,
      },
      variants: [],
    };

    this.library.add(media);
    return media;
  }
}

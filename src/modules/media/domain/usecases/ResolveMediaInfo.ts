import { v4 as uuid } from 'uuid';

import { YoutubeInfoSource } from '../../infra/info/YoutubeInfoSource.js';
import { normalizeMediaInfo } from '../utils/normalizeMedia.js';
import { mediaLibrary } from '../library/index.js';
import { detectSourceOrigin } from './Detect_Source_Origin.js';
import { parseSafeMediaUrl } from '../../../../shared/urlSafety.js';

import type { NormalizedMediaInfo } from './types.js';

export class ResolveMediaInfo {
  private youtube = new YoutubeInfoSource();

  async execute(url: string): Promise<NormalizedMediaInfo> {
    parseSafeMediaUrl(url);

    const origin = detectSourceOrigin(url);

    /**
     * 🔐 sourceId
     * - Solo para deduplicar
     * - Nunca se usa como filename
     */
    const sourceId = Buffer.from(url).toString('base64');

    // 🔁 Reusar si ya existe
    const existing = mediaLibrary
      .getAll()
      .find(m => m.sourceId === sourceId);

    if (existing) {
      return existing;
    }

    // ===============================
    // 🔵 YOUTUBE
    // ===============================
    if (origin === 'youtube') {
      const raw = await this.youtube.resolve(url);

      const normalized = normalizeMediaInfo({
        title: raw.title,
        artist: raw.artist
      });

      const media: NormalizedMediaInfo = {
        id: uuid(),            // interno
        publicId: uuid(),      // 🔥 usado para variantes
        source: 'youtube',
        sourceId,
        title: normalized.title,
        artist: normalized.artist,
        duration: raw.duration,
        thumbnail: raw.thumbnail,
        rawTitle: raw.title,
        rawArtist: raw.artist,
        extras: normalized.extras,
        variants: []           // 👈 IMPORTANTÍSIMO
      };

      mediaLibrary.add(media);
      return media;
    }

    // ===============================
    // 🟡 FUENTES GENÉRICAS
    // ===============================
    const media: NormalizedMediaInfo = {
      id: uuid(),
      publicId: uuid(),
      source: origin,
      sourceId,
      title: 'Unknown title',
      artist: origin,
      duration: 0,
      thumbnail: null,
      rawTitle: undefined,
      rawArtist: undefined,
      extras: {
        generic: true
      },
      variants: []
    };

    mediaLibrary.add(media);
    return media;
  }

}

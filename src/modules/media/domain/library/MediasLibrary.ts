import { NormalizedMediaInfo } from '../usecases/types.js';
import { MediaVariant } from './MediaVariant.js';

export interface MediaLibrary {
  /* ===============================
   * MEDIA
   * =============================== */

  add(media: NormalizedMediaInfo): void;

  getAll(): NormalizedMediaInfo[];

  getById(id: string): NormalizedMediaInfo | undefined;

  updateSource(
    mediaId: string,
    source: NormalizedMediaInfo['source'],
    sourceId?: string
  ): void;

  /* ===============================
   * QUERIES
   * =============================== */

  query(params: {
    source?: string;
    q?: string;
    order?: string;
  }): NormalizedMediaInfo[];

  getByArtist(artist: string): NormalizedMediaInfo[];

  getGroupedByArtist(): Record<string, NormalizedMediaInfo[]>;

  /* ===============================
   * VARIANTS
   * =============================== */

  addVariant(mediaId: string, variant: MediaVariant): void;

  getVariant(
    mediaId: string,
    kind: string,
    format: string
  ): MediaVariant | undefined;

  removeVariant(
    mediaId: string,
    kind: string,
    format: string
  ): void;

  hasVariant(
    mediaId: string,
    kind: string,
    format: string
  ): boolean;

  getVariants(mediaId: string): MediaVariant[];
}

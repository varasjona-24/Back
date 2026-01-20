import fs from 'fs';
import path from 'path';

import { MediaLibrary } from './MediasLibrary.js';
import { NormalizedMediaInfo } from '../usecases/types.js';
import { MediaVariant } from './MediaVariant.js';

type MediaRecord = NormalizedMediaInfo & {
  variants?: MediaVariant[];
};

export class JsonMediaLibrary implements MediaLibrary {

  private items = new Map<string, MediaRecord>();

  constructor(private filePath: string) {
    this.load();
  }

  /* ===============================
   * CRUD BÁSICO
   * =============================== */

  add(media: NormalizedMediaInfo): void {
    this.items.set(media.id, {
      ...media,
      variants: []
    });
    this.save();
  }

  getAll(): NormalizedMediaInfo[] {
    return Array.from(this.items.values());
  }

  getById(id: string): NormalizedMediaInfo | undefined {
    return this.items.get(id);
  }

  updateSource(
    mediaId: string,
    source: NormalizedMediaInfo['source'],
    sourceId?: string
  ): void {
    const media = this.items.get(mediaId);

    if (!media) {
      throw new Error(`Media ${mediaId} not found`);
    }

    let dirty = false;

    if (media.source === 'generic' && source !== 'generic') {
      media.source = source;
      dirty = true;
    }

    if (
      sourceId &&
      sourceId.trim().length > 0 &&
      (media.sourceId ?? '').trim().length === 0
    ) {
      media.sourceId = sourceId;
      dirty = true;
    }

    if (dirty) this.save();
  }

  /* ===============================
   * VARIANTES
   * =============================== */

  addVariant(mediaId: string, variant: MediaVariant): void {
    const media = this.items.get(mediaId);

    if (!media) {
      throw new Error(`Media ${mediaId} not found`);
    }

    media.variants ??= [];
    media.variants.push(variant);

    this.save();
  }

  getVariants(mediaId: string): MediaVariant[] {
    return this.items.get(mediaId)?.variants ?? [];
  }
  getVariant(mediaId: string, kind: string, format: string) {
    return this.items
      .get(mediaId)
      ?.variants
      ?.find(v => v.kind === kind && v.format === format);
  }

  hasVariant(mediaId: string, kind: string, format: string): boolean {
    return Boolean(this.getVariant(mediaId, kind, format));
  }
  /* ===============================
   * CONSULTAS (USADAS POR CONTROLLER)
   * =============================== */

  query(params: {
    source?: string;
    q?: string;
    order?: string;
  }): NormalizedMediaInfo[] {

    let result = Array.from(this.items.values());

    if (params.source) {
      result = result.filter(m => m.source === params.source);
    }

    if (params.q) {
      const q = params.q.toLowerCase();
      result = result.filter(m =>
        m.title.toLowerCase().includes(q) ||
        m.artist.toLowerCase().includes(q)
      );
    }

    if (params.order === 'title') {
      result = result.sort((a, b) => a.title.localeCompare(b.title));
    }

    if (params.order === 'artist') {
      result = result.sort((a, b) => a.artist.localeCompare(b.artist));
    }

    return result;
  }

  getByArtist(artist: string): NormalizedMediaInfo[] {
    const a = artist.toLowerCase();

    return Array.from(this.items.values())
      .filter(m => m.artist.toLowerCase() === a);
  }

  getGroupedByArtist(): Record<string, NormalizedMediaInfo[]> {
    const grouped: Record<string, NormalizedMediaInfo[]> = {};

    for (const media of this.items.values()) {
      const artist = media.artist;

      if (!grouped[artist]) {
        grouped[artist] = [];
      }

      grouped[artist].push(media);
    }

    return grouped;
  }

  /* ===============================
   * FILE SYSTEM
   * =============================== */

  private load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, '[]', 'utf-8');
      }

      const raw = fs.readFileSync(this.filePath, 'utf-8').trim();

      if (!raw) {
        this.items.clear();
        return;
      }

      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        throw new Error('media-library.json must contain an array');
      }

      for (const item of parsed) {
        this.items.set(item.id, {
          ...item,
          variants: item.variants ?? []
        });
      }

    } catch (err) {
      console.error('⚠️ Failed to load media library, resetting file');
      console.error(err);

      // Estado seguro
      this.items.clear();

      fs.writeFileSync(this.filePath, '[]', 'utf-8');
    }
  }
  private save() {
    fs.writeFileSync(
      this.filePath,
      JSON.stringify(
        Array.from(this.items.values()),
        null,
        2
      ),
      'utf-8'
    );
  }
}

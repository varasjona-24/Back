import path from 'path';
import fs from 'fs';
import { pipeline } from 'stream/promises';

import {
  AudioSource,
  VideoSource,
  MediaKind,
  AudioFormat,
  VideoFormat,
  ResolvedMediaStream,
  DownloadQuality
} from '../usecases/types.js';

import { MediaLibrary } from '../../domain/library/MediasLibrary.js';
import { detectSourceOrigin } from './Detect_Source_Origin.js';
import {
  cleanupFile,
  cleanupTempArtifact,
  ensureDirForFile,
} from '../../../../shared/fsSafety.js';
import { parseSafeMediaUrl } from '../../../../shared/urlSafety.js';

export type DownloadMediaVariantInput = {
  mediaId: string;
  url: string;
  kind: MediaKind;
  format: AudioFormat | VideoFormat;
  quality?: DownloadQuality;
};

export class DownloadMediaVariantUseCase {

  constructor(
    private readonly audioSources: AudioSource[],
    private readonly videoSources: VideoSource[],
    private readonly mediaLibrary: MediaLibrary,
    /** storage root, ej: /Back/storage */
    private readonly basePath: string,
    /** optional TTL for temporary variants */
    private readonly variantTtlMs: number = 0
  ) {}

  async execute(input: DownloadMediaVariantInput) {
    const { mediaId, url, kind, format, quality } = input;

    parseSafeMediaUrl(url);

    const origin = detectSourceOrigin(url);
    const sourceId = Buffer.from(url).toString('base64');

    /* ======================================================
     * 1️⃣ EVITAR DUPLICADOS
     * ====================================================== */

    const existing = this.mediaLibrary.getVariant(mediaId, kind, format);

    if (existing) {
      this.mediaLibrary.updateSource(mediaId, origin, sourceId);

      return {
        filePath: existing.path, // 🔥 usar el path guardado
        format,
        kind
      };
    }

    /* ======================================================
     * 2️⃣ DESCARGA
     * ====================================================== */

    const source = this.resolveSource(url, kind);
    let mediaStream: ResolvedMediaStream;
    try {
      mediaStream = await this.getStream(
        source,
        url,
        kind,
        format,
        quality
      );
    } catch (e) {
      if (quality) {
        mediaStream = await this.getStream(
          source,
          url,
          kind,
          format,
          undefined
        );
      } else {
        throw e;
      }
    }


    const fileName = this.buildFileName(mediaId, format);
    const filePath = this.buildAbsolutePath(kind, fileName);

    await this.ensureDir(filePath);
    await this.saveStream(mediaStream, filePath);

    /* ======================================================
     * 3️⃣ REGISTRO
     * ====================================================== */

    this.mediaLibrary.addVariant(mediaId, {
      kind,
      format,
      path: filePath,
      createdAt: Date.now(),
      expiresAt: this.variantTtlMs > 0 ? Date.now() + this.variantTtlMs : undefined
    });

    this.mediaLibrary.updateSource(mediaId, origin, sourceId);

    return {
      filePath,
      format,
      kind
    };

  }
  /* ======================================================
   * FUENTES
   * ====================================================== */

  private resolveSource(url: string, kind: MediaKind) {
    const sources = kind === 'audio'
      ? this.audioSources
      : this.videoSources;

    const source = sources.find(s => s.canHandle(url));
    if (!source) throw new Error(`No ${kind} source available`);

    return source;
  }

private async getStream(
  source: AudioSource | VideoSource,
  url: string,
  kind: MediaKind,
  format: AudioFormat | VideoFormat,
  quality?: DownloadQuality
): Promise<ResolvedMediaStream> {

  if (kind === 'audio') {
    return (source as AudioSource).getAudioStream(
      url,
      undefined,
      format as AudioFormat,
      quality
    );
  }

  return (source as VideoSource).getVideoStream(url, undefined, quality);
}


  /* ======================================================
   * FILE SYSTEM
   * ====================================================== */

  private async ensureDir(filePath: string) {
    await ensureDirForFile(filePath);
  }

  private async saveStream(
    media: ResolvedMediaStream,
    filePath: string
  ) {
    try {
      await pipeline(media.stream, fs.createWriteStream(filePath));
    } catch (error) {
      await cleanupFile(filePath);
      throw error;
    } finally {
      await cleanupTempArtifact(media.tmpFilePath);
    }
  }

  /* ======================================================
   * PATH HELPERS (DEFINITIVOS)
   * ====================================================== */

  private buildFileName(
    mediaId: string,
    format: string
  ): string {
    return `${mediaId}.${format}`;
  }

  private buildAbsolutePath(
    kind: MediaKind,
    fileName: string
  ): string {
    return path.join(this.basePath, kind, fileName);
  }

}

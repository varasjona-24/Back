import { UUID } from 'crypto';
import { Readable } from 'stream';
import { MediaVariant } from '../library/MediaVariant.js';

/* ======================================================
 * TIPOS EXISTENTES (NO SE ROMPEN)
 * ====================================================== */

/**
 * Audio resuelto para streaming (uso actual del sistema)
 */
export type ResolvedAudio = {
  stream: Readable;
  mimeType: string;
  contentLength?: number;
};

export type DownloadQuality = 'low' | 'medium' | 'high';

/**
 * Fuente de audio (streaming / descarga)
 */
export interface AudioSource {
  canHandle(url: string): boolean;

  getAudioStream(
    url: string,
    rangeHeader?: string,
    format?: AudioFormat,
    quality?: DownloadQuality
  ): Promise<ResolvedAudio>;
}


/**
 * Información de media resuelta desde una fuente externa
 */
export type SourceOrigin =
  | 'youtube'
  | 'crunchyroll'
  | 'hidive'
  | 'adn'
  | 'instagram'
  | 'vimeo'
  | 'reddit'
  | 'telegram'
  | 'x'
  | 'facebook'
  | 'pinterest'
  | 'amino'
  | 'blogger'
  | 'twitch'
  | 'kick'
  | 'snapchat'
  | 'qq'
  | 'threads'
  | 'vk'
  | '4chan'
  | 'mega' 
  | 'generic';



export interface ResolvedMediaInfo {
  id: string;
  title: string;
  artist: string;
  duration: number; // ms
  thumbnail: string | null;
  source: 'youtube';
}

/**
 * Media normalizada y persistida
 */
export type NormalizedMediaInfo = {
  /** ID interno (UUID) */
  id: string;

  /** ID público estable para variantes */
  publicId: string;

  /** Origen */
  source: SourceOrigin | 'local';

  /** ID del origen (base64 del URL, etc.) */
  sourceId: string;

  /** Metadata normalizada */
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;

  /** Datos crudos */
  rawTitle?: string | null;
  rawArtist?: string | null;

  /** Extras */
  extras?: Record<string, any>;

  /** 🎯 Variantes descargadas */
  variants: MediaVariant[];
};

/* ======================================================
 * EXTENSIONES NUEVAS (NO ROMPEN NADA)
 * ====================================================== */

/**
 * Tipo lógico de media
 */
export type MediaKind = 'audio' | 'video';

/**
 * Formatos soportados (pensado para móvil)
 */
export type AudioFormat = 'mp3' | 'm4a';
export type VideoFormat = 'mp4';

/**
 * Stream genérico de media (audio o video)
 * Usado para DESCARGA y variantes
 */
export type ResolvedMediaStream = {
  stream: Readable;
  mimeType: string;
  contentLength?: number;

  /**
   * Path temporal ABSOLUTO
   * Usado solo durante descarga / procesamiento
   * Nunca se persiste en DB
   */
  tmpFilePath?: string;
};
/**
 * Fuente de video (paralela a AudioSource)
 */
export interface VideoSource {
  canHandle(url: string): boolean;

  getVideoStream(
    url: string,
    rangeHeader?: string,
    quality?: DownloadQuality
  ): Promise<ResolvedMediaStream>;
}

import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

import { ResolveMedia } from '../domain/usecases/Resolve_Media.js';
import { ResolveMediaInfo } from '../domain/usecases/ResolveMediaInfo.js';
import { DownloadMediaVariantUseCase } from '../domain/usecases/Download_Media_Variant_Use_Case.js';
import { ImportYoutubePlaylistUseCase } from '../domain/usecases/ImportYoutubePlaylistUseCase.js';

import { YoutubeAudioSource } from '../infra/audio/YoutubeAudioSource.js';
import { MegaAudioSource } from '../infra/audio/MegaAudioSource.js';
import { YoutubeVideoSource } from '../infra/video/YoutubeVideoSource.js';

import { GenericVideoSource } from '../infra/video/GenericVideoSurce.js';
import { GenericAudioSource } from '../infra/audio/GenericAudioSource.js';
import { storeYtDlpCookies } from '../infra/ytDlp.js';

// ✅ NEW: MEGA
import { MegaVideoSource } from '../infra/video/MegaVideoSources.js';
// (si luego creas MegaAudioSource, lo agregas igual)

import {
  MediaKind,
  AudioFormat,
  VideoFormat,
  DownloadQuality,
} from '../domain/usecases/types.js';

import { mediaLibrary } from '../domain/library/index.js';
import { cleanupFile, isPathInsideRoot } from '../../../shared/fsSafety.js';
import { isMegaUrl, parseSafeMediaUrl } from '../../../shared/urlSafety.js';
import { ApiErrorCode, apiError, sendApiError } from '../../../shared/apiErrors.js';

export class MediaController {
  private static readonly VARIANT_TTL_MS = 7 * 60 * 1000;
  private static readonly EXPIRED_VARIANT_SWEEP_MS = 60 * 1000;
  private static cleanupTimers = new Map<string, NodeJS.Timeout>();
  private static expiredVariantSweepTimer: NodeJS.Timeout | null = null;

  constructor() {
    MediaController.ensureExpiredVariantSweep();
  }

  private getAdminToken(req: Request): string | null {
    const headerToken = req.header('x-admin-token');
    if (headerToken) return headerToken.trim();

    const auth = req.header('authorization');
    if (auth?.toLowerCase().startsWith('bearer ')) {
      return auth.slice(7).trim();
    }

    const queryToken = req.query.token;
    if (typeof queryToken === 'string' && queryToken.trim()) {
      return queryToken.trim();
    }

    return null;
  }

  private isValidCookiesFile(content: string): boolean {
    return (
      content.includes('Netscape HTTP Cookie File') ||
      content.includes('\t.youtube.com') ||
      content.includes('youtube.com')
    );
  }

  /* ======================================================
   * STREAM AUDIO (YA EXISTE – NO SE TOCA)
   * ====================================================== */

  async stream(req: Request, res: Response) {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_INVALID_URL',
          message: 'Query param "url" is required.',
          userMessage: 'URL requerida para reproducir audio.',
          status: 400,
          retryable: false,
        })
      );
    }

    try {
      parseSafeMediaUrl(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid URL';
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_INVALID_URL',
          message,
          userMessage: 'La URL no es válida o no está permitida.',
          status: 400,
          retryable: false,
        })
      );
    }

    try {
      const useCase = new ResolveMedia([new YoutubeAudioSource()]);

      const audio = await useCase.execute(url);

      res.writeHead(200, {
        'Content-Type': audio.mimeType,
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Transfer-Encoding': 'chunked',
      });

      audio.stream.pipe(res);

      req.on('close', () => {
        audio.stream.destroy();
      });
    } catch (error) {
      console.error('[MediaController]', error);

      if (!res.headersSent) {
        sendApiError(
          res,
          apiError({
            code: 'MEDIA_DOWNLOAD_FAILED',
            message: 'Failed to stream audio.',
            userMessage: 'No se pudo reproducir el audio desde el backend.',
            status: 500,
            retryable: true,
          })
        );
      }
    }
  }

  /* ======================================================
   * RESOLVE INFO (YA EXISTE – NO SE TOCA)
   * ====================================================== */

  async resolveInfo(req: Request, res: Response) {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_INVALID_URL',
          message: 'url is required.',
          userMessage: 'URL requerida para resolver información.',
          status: 400,
        })
      );
    }

    try {
      parseSafeMediaUrl(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid URL';
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_INVALID_URL',
          message,
          userMessage: 'La URL no es válida o no está permitida.',
          status: 400,
        })
      );
    }

    try {
      const useCase = new ResolveMediaInfo();
      const info = await useCase.execute(url);
      res.json(info);
    } catch (err) {
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_UNSUPPORTED_SOURCE',
          message: err instanceof Error ? err.message : 'Failed to resolve info.',
          userMessage: 'No se pudo resolver información del medio.',
          status: 500,
          retryable: true,
        })
      );
    }
  }

  /* ======================================================
   * MEDIA LIBRARY (YA EXISTE – NO SE TOCA)
   * ====================================================== */

  async library(req: Request, res: Response) {
    const { source, q, order } = req.query;

    const result = mediaLibrary.query({
      source: typeof source === 'string' ? source : undefined,
      q: typeof q === 'string' ? q : undefined,
      order: typeof order === 'string' ? order : undefined,
    });

    res.json(result);
  }

  async libraryBYArtist(req: Request, res: Response) {
    const { artist } = req.query;

    if (typeof artist !== 'string') {
      return res.status(400).json({
        error: 'Query param "artist" is required',
      });
    }

    res.json(mediaLibrary.getByArtist(artist));
  }

  async libraryByArtist(req: Request, res: Response) {
    res.json(mediaLibrary.getGroupedByArtist());
  }

  /* ======================================================
   * ADMIN: UPDATE YT-DLP COOKIES
   * ====================================================== */

  async updateYtDlpCookies(req: Request, res: Response) {
    const expectedToken = process.env.YTDLP_ADMIN_TOKEN?.trim();
    if (!expectedToken) {
      return res.status(500).json({ error: 'YTDLP_ADMIN_TOKEN not configured' });
    }

    const providedToken = this.getAdminToken(req);
    if (!providedToken || providedToken !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { cookiesBase64, cookiesText, cookies } = req.body ?? {};
    let content = '';

    if (typeof cookiesText === 'string' && cookiesText.trim()) {
      content = cookiesText.trim();
    } else if (typeof cookies === 'string' && cookies.trim()) {
      content = cookies.trim();
    } else if (typeof cookiesBase64 === 'string' && cookiesBase64.trim()) {
      try {
        content = Buffer.from(cookiesBase64.trim(), 'base64').toString('utf-8');
      } catch {
        return res.status(400).json({ error: 'Invalid base64 cookies' });
      }
    }

    if (!content) {
      return res.status(400).json({
        error: 'Send cookiesBase64 or cookiesText in body',
      });
    }

    if (!this.isValidCookiesFile(content)) {
      return res.status(400).json({
        error: 'Cookies file does not look like Netscape format',
      });
    }

    const savedPath = await storeYtDlpCookies(content);
    return res.json({ ok: true, path: savedPath });
  }

  /* ======================================================
   * DOWNLOAD MEDIA VARIANT (MEGA INTEGRADO)
   * ====================================================== */

  async download(req: Request, res: Response) {
    const { url, kind, format, quality } = req.body;

    if (!url || !kind || !format) {
      return sendApiError(
        res,
        apiError({
          code: 'VALIDATION_ERROR',
          message: 'url, kind and format are required.',
          userMessage: 'Faltan datos para iniciar la descarga.',
          status: 400,
        })
      );
    }

    if (!['audio', 'video'].includes(kind)) {
      return sendApiError(
        res,
        apiError({
          code: 'VALIDATION_ERROR',
          message: 'kind must be audio or video.',
          userMessage: 'Tipo de descarga inválido.',
          status: 400,
        })
      );
    }

    if (typeof url !== 'string') {
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_INVALID_URL',
          message: 'url must be a string.',
          userMessage: 'URL inválida.',
          status: 400,
        })
      );
    }

    try {
      parseSafeMediaUrl(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid URL';
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_INVALID_URL',
          message,
          userMessage: 'La URL no es válida o no está permitida.',
          status: 400,
        })
      );
    }

    try {
      // ✅ Resolve info (pero si falla y es MEGA, no rompemos el flujo)
      let media: any;
      try {
        const resolveInfo = new ResolveMediaInfo();
        media = await resolveInfo.execute(url);
      } catch (e) {
        if (!isMegaUrl(url)) throw e;

        // fallback mínimo para permitir descarga de MEGA
        media = {
          id: `mega-${Date.now()}`,
          title: 'MEGA file',
          thumbnail: null,
          durationSeconds: null,
        };
      }

      const kindStr = String(kind);
      const formatStr = String(format);
      const qualityStr = quality != null ? String(quality) : '';

      const isMediaKind = (v: string): v is MediaKind =>
        v === 'audio' || v === 'video';

      const isAudioFormat = (v: string): v is AudioFormat =>
        v === 'mp3' || v === 'm4a';

      const isVideoFormat = (v: string): v is VideoFormat => v === 'mp4';
      const isDownloadQuality = (v: string): v is DownloadQuality =>
        v === 'low' || v === 'medium' || v === 'high';

      if (!isMediaKind(kindStr)) {
        return sendApiError(
          res,
          apiError({
            code: 'VALIDATION_ERROR',
            message: 'kind must be audio or video.',
            userMessage: 'Tipo de descarga inválido.',
            status: 400,
          })
        );
      }

      if (kindStr === 'audio' && !isAudioFormat(formatStr)) {
        return sendApiError(
          res,
          apiError({
            code: 'MEDIA_FORMAT_UNAVAILABLE',
            message: 'audio format must be mp3 or m4a.',
            userMessage: 'Formato de audio no disponible.',
            status: 400,
            details: { allowedFormats: ['mp3', 'm4a'] },
          })
        );
      }

      if (kindStr === 'video' && !isVideoFormat(formatStr)) {
        return sendApiError(
          res,
          apiError({
            code: 'MEDIA_FORMAT_UNAVAILABLE',
            message: 'video format must be mp4.',
            userMessage: 'Formato de video no disponible.',
            status: 400,
            details: { allowedFormats: ['mp4'] },
          })
        );
      }

      if (qualityStr && !isDownloadQuality(qualityStr)) {
        return sendApiError(
          res,
          apiError({
            code: 'VALIDATION_ERROR',
            message: 'quality must be low, medium, or high.',
            userMessage: 'Calidad de descarga inválida.',
            status: 400,
          })
        );
      }

      // ✅ MegaVideoSource ANTES que GenericVideoSource
      const downloadUseCase = new DownloadMediaVariantUseCase(
        [
          new YoutubeAudioSource(),
          new MegaAudioSource(), // ✅ MEGA audio
          new GenericAudioSource(), // fallback
        ],
        [
          new YoutubeVideoSource(),
          new MegaVideoSource(), // ✅ MEGA
          new GenericVideoSource(), // fallback
        ],
        mediaLibrary,
        process.env.MEDIA_PATH || 'media',
        MediaController.VARIANT_TTL_MS
      );

      const resolvedFormat: AudioFormat | VideoFormat =
        kindStr === 'audio'
          ? (formatStr as AudioFormat)
          : (formatStr as VideoFormat);

      const result = await downloadUseCase.execute({
        mediaId: media.id,
        url,
        kind: kindStr,
        format: resolvedFormat,
        quality: qualityStr ? (qualityStr as DownloadQuality) : undefined,
      });

      return res.status(201).json({
        mediaId: media.id,
        variant: {
          kind: result.kind,
          format: result.format,
          path: result.filePath,
        },
      });
    } catch (err: any) {
      console.error('[MediaController.download]', err);
      const classified = this.classifyDownloadFailure(err);
      return sendApiError(
        res,
        apiError({
          code: classified.code,
          message: err.message ?? 'Failed to download media.',
          userMessage: classified.userMessage,
          status: classified.status,
          retryable: classified.retryable,
          retryAfterSeconds: classified.retryAfterSeconds,
        })
      );
    }
  }

  async importPlaylist(req: Request, res: Response) {
    const { url, kind, format, quality, maxItems, playlistName } = req.body ?? {};

    if (!url || !kind || !format) {
      return sendApiError(
        res,
        apiError({
          code: 'VALIDATION_ERROR',
          message: 'url, kind and format are required.',
          userMessage: 'Faltan datos para importar la playlist.',
          status: 400,
        })
      );
    }

    if (typeof url !== 'string') {
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_INVALID_URL',
          message: 'url must be a string.',
          userMessage: 'URL inválida.',
          status: 400,
        })
      );
    }

    try {
      parseSafeMediaUrl(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid URL';
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_INVALID_URL',
          message,
          userMessage: 'La URL no es válida o no está permitida.',
          status: 400,
        })
      );
    }

    const kindStr = String(kind);
    const formatStr = String(format);
    const qualityStr = quality != null ? String(quality) : '';
    const maxItemsNumber = maxItems == null ? 50 : Number(maxItems);

    const isMediaKind = (v: string): v is MediaKind =>
      v === 'audio' || v === 'video';
    const isAudioFormat = (v: string): v is AudioFormat =>
      v === 'mp3' || v === 'm4a';
    const isVideoFormat = (v: string): v is VideoFormat => v === 'mp4';
    const isDownloadQuality = (v: string): v is DownloadQuality =>
      v === 'low' || v === 'medium' || v === 'high';

    if (!isMediaKind(kindStr)) {
      return sendApiError(
        res,
        apiError({
          code: 'VALIDATION_ERROR',
          message: 'kind must be audio or video.',
          userMessage: 'Tipo de importación inválido.',
          status: 400,
        })
      );
    }

    if (kindStr === 'audio' && !isAudioFormat(formatStr)) {
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_FORMAT_UNAVAILABLE',
          message: 'audio format must be mp3 or m4a.',
          userMessage: 'Formato de audio no disponible.',
          status: 400,
          details: { allowedFormats: ['mp3', 'm4a'] },
        })
      );
    }

    if (kindStr === 'video' && !isVideoFormat(formatStr)) {
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_FORMAT_UNAVAILABLE',
          message: 'video format must be mp4.',
          userMessage: 'Formato de video no disponible.',
          status: 400,
          details: { allowedFormats: ['mp4'] },
        })
      );
    }

    if (qualityStr && !isDownloadQuality(qualityStr)) {
      return sendApiError(
        res,
        apiError({
          code: 'VALIDATION_ERROR',
          message: 'quality must be low, medium, or high.',
          userMessage: 'Calidad de descarga inválida.',
          status: 400,
        })
      );
    }

    if (!Number.isFinite(maxItemsNumber) || maxItemsNumber < 1) {
      return sendApiError(
        res,
        apiError({
          code: 'VALIDATION_ERROR',
          message: 'maxItems must be a positive number.',
          userMessage: 'La cantidad de canciones a importar no es válida.',
          status: 400,
        })
      );
    }

    try {
      const useCase = new ImportYoutubePlaylistUseCase();
      const result = await useCase.execute({
        url,
        kind: kindStr,
        format: kindStr === 'audio'
          ? (formatStr as AudioFormat)
          : (formatStr as VideoFormat),
        quality: qualityStr ? (qualityStr as DownloadQuality) : undefined,
        maxItems: maxItemsNumber,
        playlistName: typeof playlistName === 'string' ? playlistName : undefined,
      });

      return res.status(201).json(result);
    } catch (err: any) {
      console.error('[MediaController.importPlaylist]', err);
      const classified = this.classifyDownloadFailure(err);
      return sendApiError(
        res,
        apiError({
          code: classified.code,
          message: err.message ?? 'Failed to import playlist.',
          userMessage: classified.userMessage,
          status: classified.status,
          retryable: classified.retryable,
          retryAfterSeconds: classified.retryAfterSeconds,
        })
      );
    }
  }

  /* ======================================================
   * 🆕 SERVIR ARCHIVO DESCARGADO
   * GET /media/file/:mediaId/:kind/:format
   * ====================================================== */
  async file(req: Request, res: Response) {
    const { mediaId, kind, format } = req.params;

    const variant = mediaLibrary.getVariant(mediaId, kind, format);
    if (!variant) {
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_FILE_NOT_FOUND',
          message: 'Variant not found.',
          userMessage: 'La variante remota no existe o expiró.',
          status: 404,
          retryable: false,
        })
      );
    }

    // ✅ Usa el path guardado tal cual (ya lo tienes en media-library.json)
    const filePath = path.resolve(variant.path);

    if (variant.expiresAt && Date.now() >= variant.expiresAt) {
      this.cleanupVariant(mediaId, kind, format, filePath);
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_VARIANT_EXPIRED',
          message: 'File expired.',
          userMessage: 'La variante remota expiró.',
          status: 404,
          retryable: false,
        })
      );
    }

    if (!fs.existsSync(filePath)) {
      mediaLibrary.removeVariant(mediaId, kind, format);
      return sendApiError(
        res,
        apiError({
          code: 'MEDIA_FILE_NOT_FOUND',
          message: 'File not found on disk.',
          userMessage: 'El archivo remoto ya no está disponible.',
          status: 404,
          retryable: false,
        })
      );
    }

    const stat = fs.statSync(filePath);

    const mime =
      kind === 'audio'
        ? format === 'mp3'
          ? 'audio/mpeg'
          : 'audio/mp4'
        : 'video/mp4';

    // Headers base (AVPlayer los espera)
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Length', stat.size.toString());

    // ✅ MUY IMPORTANTE: responder HEAD sin body
    if (req.method === 'HEAD') {
      return res.status(200).end();
    }

    const range = req.headers.range;

    if (!range) {
      // 200 completo
      this.scheduleCleanup(mediaId, kind, format, filePath, variant.expiresAt);
      return fs.createReadStream(filePath).pipe(res);
    }

    // 206 parcial
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = Number.parseInt(startStr, 10);
    const end = endStr ? Number.parseInt(endStr, 10) : stat.size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      return res.status(416).end(); // Range Not Satisfiable
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', String(end - start + 1));

    this.scheduleCleanup(mediaId, kind, format, filePath, variant.expiresAt);
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  private scheduleCleanup(
    mediaId: string,
    kind: string,
    format: string,
    filePath: string,
    expiresAt?: number
  ) {
    if (!expiresAt) return;

    const key = `${mediaId}:${kind}:${format}`;
    if (MediaController.cleanupTimers.has(key)) return;

    const delay = Math.max(0, expiresAt - Date.now());

    const timer = setTimeout(() => {
      MediaController.cleanupTimers.delete(key);
      this.cleanupVariant(mediaId, kind, format, filePath);
    }, delay);

    MediaController.cleanupTimers.set(key, timer);
  }

  private cleanupVariant(
    mediaId: string,
    kind: string,
    format: string,
    filePath: string
  ) {
    void MediaController.cleanupVariantFile(filePath);
    mediaLibrary.removeVariant(mediaId, kind, format);
  }

  private static ensureExpiredVariantSweep() {
    if (MediaController.expiredVariantSweepTimer) return;

    const sweep = () => {
      mediaLibrary.removeExpiredVariants(Date.now(), variant => {
        void MediaController.cleanupVariantFile(variant.path);
      });
    };

    sweep();
    const timer = setInterval(sweep, MediaController.EXPIRED_VARIANT_SWEEP_MS);
    timer.unref();
    MediaController.expiredVariantSweepTimer = timer;
  }

  private static async cleanupVariantFile(filePath: string) {
    const mediaRoot = path.resolve(process.env.MEDIA_PATH || 'media');
    const resolved = path.resolve(filePath);
    if (!isPathInsideRoot(mediaRoot, resolved)) return;

    await cleanupFile(resolved);
  }

  private classifyDownloadFailure(error: unknown): {
    code: ApiErrorCode;
    userMessage: string;
    status: number;
    retryable: boolean;
    retryAfterSeconds?: number;
  } {
    const raw = error instanceof Error ? error.message : String(error ?? '');
    const message = raw.toLowerCase();

    if (
      message.includes('not a bot') ||
      message.includes('sign in') ||
      message.includes('cookie') ||
      message.includes('confirm your age')
    ) {
      return {
        code: 'MEDIA_COOKIES_REQUIRED',
        userMessage: 'La fuente requiere cookies o iniciar sesión para descargar.',
        status: 409,
        retryable: false,
      };
    }

    if (
      message.includes('drm') ||
      message.includes('protected') ||
      message.includes('copyright') ||
      message.includes('encrypted')
    ) {
      return {
        code: 'MEDIA_PROTECTED_CONTENT',
        userMessage: 'Este contenido está protegido y no se puede descargar.',
        status: 409,
        retryable: false,
      };
    }

    if (
      message.includes('requested format is not available') ||
      message.includes('format is not available') ||
      message.includes('no video formats') ||
      message.includes('no audio formats') ||
      message.includes('no source available')
    ) {
      return {
        code: 'MEDIA_FORMAT_UNAVAILABLE',
        userMessage: 'No hay un formato compatible disponible para esta fuente.',
        status: 422,
        retryable: false,
      };
    }

    if (message.includes('timeout') || message.includes('timed out')) {
      return {
        code: 'MEDIA_DOWNLOAD_TIMEOUT',
        userMessage: 'La descarga tardó demasiado en el backend.',
        status: 504,
        retryable: true,
        retryAfterSeconds: 60,
      };
    }

    return {
      code: 'MEDIA_DOWNLOAD_FAILED',
      userMessage: 'No se pudo completar la descarga en el backend.',
      status: 500,
      retryable: true,
      retryAfterSeconds: 60,
    };
  }
}

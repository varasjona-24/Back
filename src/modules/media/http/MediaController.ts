import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

import { ResolveMedia } from '../domain/usecases/Resolve_Media.js';
import { ResolveMediaInfo } from '../domain/usecases/ResolveMediaInfo.js';
import { DownloadMediaVariantUseCase } from '../domain/usecases/Download_Media_Variant_Use_Case.js';

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

export class MediaController {
  private static readonly VARIANT_TTL_MS = 7 * 60 * 1000;
  private static cleanupTimers = new Map<string, NodeJS.Timeout>();

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
      return res.status(400).json({
        error: 'Query param "url" is required',
      });
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
        res.status(500).json({
          error: 'Failed to stream audio',
        });
      }
    }
  }

  /* ======================================================
   * RESOLVE INFO (YA EXISTE – NO SE TOCA)
   * ====================================================== */

  async resolveInfo(req: Request, res: Response) {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }

    try {
      const useCase = new ResolveMediaInfo();
      const info = await useCase.execute(url);
      res.json(info);
    } catch (err) {
      res.status(500).json({ error: 'Failed to resolve info' });
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
      return res.status(400).json({
        error: 'url, kind and format are required',
      });
    }

    if (!['audio', 'video'].includes(kind)) {
      return res.status(400).json({
        error: 'kind must be audio or video',
      });
    }

    try {
      // ✅ Resolve info (pero si falla y es MEGA, no rompemos el flujo)
      let media: any;
      try {
        const resolveInfo = new ResolveMediaInfo();
        media = await resolveInfo.execute(url);
      } catch (e) {
        const u = String(url).toLowerCase();
        const isMega = u.includes('mega.nz/') || u.includes('mega.co.nz/');
        if (!isMega) throw e;

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
        return res.status(400).json({ error: 'kind must be audio or video' });
      }

      if (kindStr === 'audio' && !isAudioFormat(formatStr)) {
        return res
          .status(400)
          .json({ error: 'audio format must be mp3 or m4a' });
      }

      if (kindStr === 'video' && !isVideoFormat(formatStr)) {
        return res.status(400).json({ error: 'video format must be mp4' });
      }

      if (qualityStr && !isDownloadQuality(qualityStr)) {
        return res.status(400).json({ error: 'quality must be low, medium, or high' });
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
      return res.status(500).json({
        error: err.message ?? 'Failed to download media',
      });
    }
  }

  /* ======================================================
   * 🆕 SERVIR ARCHIVO DESCARGADO
   * GET /media/file/:mediaId/:kind/:format
   * ====================================================== */
  async file(req: Request, res: Response) {
    const { mediaId, kind, format } = req.params;

    const variant = mediaLibrary.getVariant(mediaId, kind, format);
    if (!variant) return res.status(404).json({ error: 'Variant not found' });

    // ✅ Usa el path guardado tal cual (ya lo tienes en media-library.json)
    const filePath = path.resolve(variant.path);

    if (variant.expiresAt && Date.now() >= variant.expiresAt) {
      this.cleanupVariant(mediaId, kind, format, filePath);
      return res.status(404).json({ error: 'File expired' });
    }

    if (!fs.existsSync(filePath)) {
      mediaLibrary.removeVariant(mediaId, kind, format);
      return res.status(404).json({ error: 'File not found on disk' });
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
    fs.promises.unlink(filePath).catch(() => {});
    mediaLibrary.removeVariant(mediaId, kind, format);
  }
}

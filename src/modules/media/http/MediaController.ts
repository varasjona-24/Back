import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

import { ResolveMedia } from '../domain/usecases/Resolve_Media.js';
import { ResolveMediaInfo } from '../domain/usecases/ResolveMediaInfo.js';
import { DownloadMediaVariantUseCase } from '../domain/usecases/Download_Media_Variant_Use_Case.js';

import { YoutubeAudioSource } from '../infra/audio/YoutubeAudioSource.js';
import { YoutubeVideoSource } from '../infra/video/YoutubeVideoSource.js';

import {
  MediaKind,
  AudioFormat,
  VideoFormat
} from '../domain/usecases/types.js';

import { mediaLibrary } from '../domain/library/index.js';
import { GenericVideoSource } from '../infra/video/GenericVideoSurce.js';
import { GenericAudioSource } from '../infra/audio/GenericAudioSource.js';

export class MediaController {

  /* ======================================================
   * STREAM AUDIO (YA EXISTE – NO SE TOCA)
   * ====================================================== */

  async stream(req: Request, res: Response) {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'Query param "url" is required'
      });
    }

    try {
      const useCase = new ResolveMedia([
        new YoutubeAudioSource()
      ]);

      const audio = await useCase.execute(url);

      res.writeHead(200, {
        'Content-Type': audio.mimeType,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Transfer-Encoding': 'chunked'
      });

      audio.stream.pipe(res);

      req.on('close', () => {
        audio.stream.destroy();
      });

    } catch (error) {
      console.error('[MediaController]', error);

      if (!res.headersSent) {
        res.status(500).json({
          error: 'Failed to stream audio'
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
      order: typeof order === 'string' ? order : undefined
    });

    res.json(result);
  }

  async libraryBYArtist(req: Request, res: Response) {
    const { artist } = req.query;

    if (typeof artist !== 'string') {
      return res.status(400).json({
        error: 'Query param "artist" is required'
      });
    }

    res.json(mediaLibrary.getByArtist(artist));
  }

  async libraryByArtist(req: Request, res: Response) {
    res.json(mediaLibrary.getGroupedByArtist());
  }

  /* ======================================================
   * DOWNLOAD MEDIA VARIANT (YA EXISTE – NO SE TOCA)
   * ====================================================== */

  async download(req: Request, res: Response) {
    const { url, kind, format } = req.body;

    if (!url || !kind || !format) {
      return res.status(400).json({
        error: 'url, kind and format are required'
      });
    }

    if (!['audio', 'video'].includes(kind)) {
      return res.status(400).json({
        error: 'kind must be audio or video'
      });
    }

    try {
      const resolveInfo = new ResolveMediaInfo();
      const media = await resolveInfo.execute(url);

      const kindStr = String(kind);
      const formatStr = String(format);

      const isMediaKind = (v: string): v is MediaKind =>
        v === 'audio' || v === 'video';

      const isAudioFormat = (v: string): v is AudioFormat =>
        v === 'mp3' || v === 'm4a';

      const isVideoFormat = (v: string): v is VideoFormat =>
        v === 'mp4';

      if (!isMediaKind(kindStr)) {
        return res.status(400).json({ error: 'kind must be audio or video' });
      }

      if (kindStr === 'audio' && !isAudioFormat(formatStr)) {
        return res.status(400).json({ error: 'audio format must be mp3 or m4a' });
      }

      if (kindStr === 'video' && !isVideoFormat(formatStr)) {
        return res.status(400).json({ error: 'video format must be mp4' });
      }

     const downloadUseCase = new DownloadMediaVariantUseCase(
  [
    new YoutubeAudioSource(),
    new GenericAudioSource() // 👈 fallback
  ],
  [
    new YoutubeVideoSource(),
    new GenericVideoSource() // 👈 fallback
  ],
  mediaLibrary,
  process.env.MEDIA_PATH || 'media'
);

      let resolvedFormat: AudioFormat | VideoFormat;

      if (kindStr === 'audio') {
        resolvedFormat = formatStr as AudioFormat;
      } else {
        resolvedFormat = formatStr as VideoFormat;
      }

      const result = await downloadUseCase.execute({
        mediaId: media.id,
        url,
        kind: kindStr,
        format: resolvedFormat
      });

      return res.status(201).json({
        mediaId: media.id,
        variant: {
          kind: result.kind,
          format: result.format,
          path: result.filePath
        }
      });

    } catch (err: any) {
      console.error('[MediaController.download]', err);
      return res.status(500).json({
        error: err.message ?? 'Failed to download media'
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

  if (!fs.existsSync(filePath)) {
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

  return fs.createReadStream(filePath, { start, end }).pipe(res);
}

}
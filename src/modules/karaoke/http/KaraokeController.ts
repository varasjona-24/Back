import fs from 'fs';
import path from 'path';
import { Request, Response } from 'express';
import { KaraokeJob, KaraokeJobService, karaokeJobService } from '../domain/KaraokeJobService.js';
import {
  KaraokeSession,
  KaraokeVariantMode,
  KaraokeSessionService,
  karaokeSessionService,
} from '../domain/KaraokeSessionService.js';

type KaraokeJobApiResult = {
  model: string;
  instrumentalUrl: string;
  completedAt: number;
  durationMs: number;
};

type KaraokeJobApi = {
  id: string;
  status: KaraokeJob['status'];
  progress: number;
  message: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  input: {
    mediaId?: string;
    title?: string;
    artist?: string;
    source?: string;
  };
  result?: KaraokeJobApiResult;
};

export class KaraokeController {
  constructor(
    private readonly jobs: KaraokeJobService = karaokeJobService,
    private readonly sessions: KaraokeSessionService = karaokeSessionService
  ) {}

  health(_req: Request, res: Response) {
    return res.json({
      ok: true,
      service: 'karaoke',
      at: Date.now(),
    });
  }

  createJob(req: Request, res: Response) {
    try {
      const { mediaId, title, artist, source, sourcePath } = req.body ?? {};
      const job = this.jobs.createJob({
        mediaId: typeof mediaId === 'string' ? mediaId : undefined,
        title: typeof title === 'string' ? title : undefined,
        artist: typeof artist === 'string' ? artist : undefined,
        source: typeof source === 'string' ? source : undefined,
        sourcePath: typeof sourcePath === 'string' ? sourcePath : undefined,
      });

      return res.status(202).json({
        jobId: job.id,
        job: this.toApiJob(job),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'No se pudo crear job de karaoke';
      return res.status(400).json({ error: message });
    }
  }

  getJob(req: Request, res: Response) {
    const jobId = req.params.jobId?.trim();
    if (!jobId) {
      return res.status(400).json({ error: 'jobId es requerido' });
    }

    const job = this.jobs.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job no encontrado' });
    }

    return res.json({ job: this.toApiJob(job) });
  }

  createSession(req: Request, res: Response) {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Body binario requerido (audio fuente).' });
    }

    try {
      const mediaId = this.stringQuery(req.query.mediaId);
      const title = this.stringQuery(req.query.title);
      const artist = this.stringQuery(req.query.artist);
      const source = this.stringQuery(req.query.source);
      const mode = this.parseMode(this.stringQuery(req.query.mode));
      const filename =
        this.stringQuery(req.query.filename) ??
        this.fileNameFromHeader(req.header('x-filename')) ??
        'source.wav';

      const session = this.sessions.createSessionFromUpload({
        sourceBytes: req.body,
        sourceFilename: filename,
        input: {
          mediaId,
          title,
          artist,
          source,
        },
        mode,
      });

      return res.status(202).json({
        sessionId: session.id,
        session: this.toApiSession(session),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'No se pudo crear sesión remota';
      return res.status(400).json({ error: message });
    }
  }

  getSession(req: Request, res: Response) {
    const sessionId = req.params.sessionId?.trim();
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId es requerido' });
    }

    const session = this.sessions.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Sesión no encontrada' });
    }

    return res.json({ session: this.toApiSession(session) });
  }

  sessionInstrumental(req: Request, res: Response) {
    const sessionId = req.params.sessionId?.trim();
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId es requerido' });
    }

    const filePath = this.sessions.getInstrumentalPath(sessionId);
    if (!filePath) {
      return res.status(404).json({ error: 'Instrumental no disponible' });
    }

    this.sessions.markInstrumentalServed(sessionId);
    return this.streamAudioFile(req, res, filePath);
  }

  sessionSpatial8d(req: Request, res: Response) {
    const sessionId = req.params.sessionId?.trim();
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId es requerido' });
    }

    const filePath = this.sessions.getSpatial8dPath(sessionId);
    if (!filePath) {
      return res.status(404).json({ error: 'Audio 8D no disponible' });
    }

    this.sessions.markSpatial8dServed(sessionId);
    return this.streamAudioFile(req, res, filePath);
  }

  instrumental(req: Request, res: Response) {
    const jobId = req.params.jobId?.trim();
    if (!jobId) {
      return res.status(400).json({ error: 'jobId es requerido' });
    }

    const filePath = this.jobs.getInstrumentalPath(jobId);
    if (!filePath) {
      return res.status(404).json({ error: 'Instrumental no disponible' });
    }

    const resolved = path.resolve(filePath);
    return this.streamAudioFile(req, res, resolved);
  }

  private toApiJob(job: KaraokeJob): KaraokeJobApi {
    const base: KaraokeJobApi = {
      id: job.id,
      status: job.status,
      progress: job.progress,
      message: job.message,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      input: {
        mediaId: job.input.mediaId,
        title: job.input.title,
        artist: job.input.artist,
        source: job.input.source,
      },
    };

    if (!job.result) return base;

    return {
      ...base,
      result: {
        model: job.result.model,
        completedAt: job.result.completedAt,
        durationMs: job.result.durationMs,
        instrumentalUrl: `/api/v1/karaoke/jobs/${job.id}/instrumental`,
      },
    };
  }

  private toApiSession(session: KaraokeSession) {
    return {
      id: session.id,
      mode: session.mode,
      status: session.status,
      progress: session.progress,
      message: session.message,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      input: session.input,
      separatorModel: session.separatorModel,
      error: session.error,
      result: {
        mode: session.mode,
        instrumentalUrl: session.instrumentalPath
            ? `/api/v1/karaoke/sessions/${session.id}/instrumental`
            : null,
        instrumentalExpiresAt: session.instrumentalExpiresAt ?? null,
        spatial8dUrl: session.spatial8dPath
            ? `/api/v1/karaoke/sessions/${session.id}/spatial8d`
            : null,
        spatial8dExpiresAt: session.spatial8dExpiresAt ?? null,
      },
    };
  }

  private streamAudioFile(req: Request, res: Response, filePath: string) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'Archivo de audio no existe' });
    }

    const stat = fs.statSync(resolved);
    const range = req.headers.range;

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    if (!range) {
      res.setHeader('Content-Length', stat.size.toString());
      if (req.method === 'HEAD') {
        return res.status(200).end();
      }
      return fs.createReadStream(resolved).pipe(res);
    }

    const [startStr, endStr] = range.replace('bytes=', '').split('-');
    const start = Number.parseInt(startStr, 10);
    const end = endStr ? Number.parseInt(endStr, 10) : stat.size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      return res.status(416).end();
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', String(end - start + 1));

    return fs.createReadStream(resolved, { start, end }).pipe(res);
  }

  private stringQuery(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const value = raw.trim();
    return value.length === 0 ? undefined : value;
  }

  private fileNameFromHeader(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const value = raw.trim();
    return value.length === 0 ? undefined : value;
  }

  private parseMode(raw: string | undefined): KaraokeVariantMode {
    const value = raw?.trim().toLowerCase() ?? '';
    if (value === 'spatial8d' || value === '8d' || value === 'spatial') {
      return 'spatial8d';
    }
    return 'instrumental';
  }

}

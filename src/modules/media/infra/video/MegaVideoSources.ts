import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

import type {
  VideoSource,
  ResolvedMediaStream,
  DownloadQuality,
} from '../../domain/usecases/types.js';
import { getMegaApi } from '../mega/megaAuth.js';

type MegaApiLike = object;

type MegaFileLike = {
  name?: string;
  loadAttributes: (cb: (error?: Error | null) => void) => void;
  download: (options?: Record<string, unknown>) => NodeJS.ReadableStream;
};

type MegaModuleLike = {
  File: {
    fromURL: (
      url: string,
      extraOpt?: {
        api?: MegaApiLike;
      }
    ) => MegaFileLike;
  };
};

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.3gp': 'video/3gpp',
};

function unlinkQuiet(filePath: string) {
  fs.promises.unlink(filePath).catch(() => {});
}

async function loadMegaFile(url: string): Promise<MegaFileLike> {
  const mega = (await import('megajs')) as unknown as MegaModuleLike;

  if (!mega?.File?.fromURL) {
    throw new Error('megajs is not available');
  }

  const api = await getMegaApi();
  const file = mega.File.fromURL(url, api ? { api } : undefined);

  await new Promise<void>((resolve, reject) => {
    file.loadAttributes((error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  return file;
}

function buildTmpFilePath(tmpDir: string, rawName?: string): string {
  const safeName = path.basename(rawName || `mega-video-${Date.now()}.bin`);
  const prefix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return path.join(tmpDir, `${prefix}-${safeName}`);
}

function resolveVideoMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export class MegaVideoSource implements VideoSource {
  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('mega.nz/') || u.includes('mega.co.nz/');
  }

  async getVideoStream(
    url: string,
    _range?: string,
    _quality?: DownloadQuality
  ): Promise<ResolvedMediaStream> {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tmpDir = path.resolve('tmp', `mega-video-${token}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const megaFile = await loadMegaFile(url);
    const tmpFilePath = buildTmpFilePath(tmpDir, megaFile.name);

    await pipeline(megaFile.download({}), fs.createWriteStream(tmpFilePath));

    const stat = await fs.promises.stat(tmpFilePath);
    if (stat.size <= 0) {
      unlinkQuiet(tmpFilePath);
      throw new Error('Downloaded MEGA video file is empty');
    }

    return {
      stream: fs.createReadStream(tmpFilePath),
      mimeType: resolveVideoMime(tmpFilePath),
      tmpFilePath,
    };
  }
}

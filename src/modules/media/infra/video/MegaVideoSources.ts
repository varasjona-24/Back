import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

import type {
  VideoSource,
  ResolvedMediaStream,
  DownloadQuality,
} from '../../domain/usecases/types.js';

type MegaFileLike = {
  name?: string;
  loadAttributes: (cb: (error?: Error | null) => void) => void;
  download: (options?: Record<string, unknown>) => NodeJS.ReadableStream;
};

type MegaModuleLike = {
  File: {
    fromURL: (url: string) => MegaFileLike;
  };
};

function unlinkQuiet(filePath: string) {
  fs.promises.unlink(filePath).catch(() => {});
}

async function loadMegaFile(url: string): Promise<MegaFileLike> {
  const mega = (await import('megajs')) as unknown as MegaModuleLike;

  if (!mega?.File?.fromURL) {
    throw new Error('megajs is not available');
  }

  const file = mega.File.fromURL(url);

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

function looksLikeMp4(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.mp4' || ext === '.m4v';
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

    if (!looksLikeMp4(tmpFilePath)) {
      unlinkQuiet(tmpFilePath);
      throw new Error(
        'MEGA video must be .mp4/.m4v when running without ffmpeg'
      );
    }

    return {
      stream: fs.createReadStream(tmpFilePath),
      mimeType: 'video/mp4',
      tmpFilePath,
    };
  }
}

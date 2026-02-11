import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

import type {
  AudioSource,
  AudioFormat,
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

function unlinkQuiet(filePath: string) {
  fs.promises.unlink(filePath).catch(() => {});
}

function resolveAudioFormatFromPath(filePath: string): AudioFormat | null {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.mp3') return 'mp3';
  if (ext === '.m4a' || ext === '.aac') return 'm4a';

  return null;
}

function audioMime(format: AudioFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
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
  const safeName = path.basename(rawName || `mega-audio-${Date.now()}.bin`);
  const prefix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return path.join(tmpDir, `${prefix}-${safeName}`);
}

export class MegaAudioSource implements AudioSource {
  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('mega.nz/') || u.includes('mega.co.nz/');
  }

  async getAudioStream(
    url: string,
    _range?: string,
    format: AudioFormat = 'm4a',
    _quality?: DownloadQuality
  ): Promise<ResolvedMediaStream> {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tmpDir = path.resolve('tmp', `mega-audio-${token}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const megaFile = await loadMegaFile(url);
    const tmpFilePath = buildTmpFilePath(tmpDir, megaFile.name);

    await pipeline(megaFile.download({}), fs.createWriteStream(tmpFilePath));

    const stat = await fs.promises.stat(tmpFilePath);
    if (stat.size <= 0) {
      unlinkQuiet(tmpFilePath);
      throw new Error('Downloaded MEGA audio file is empty');
    }

    const detectedFormat = resolveAudioFormatFromPath(tmpFilePath);
    if (!detectedFormat) {
      unlinkQuiet(tmpFilePath);
      throw new Error(
        'MEGA audio must be .mp3, .m4a or .aac when running without ffmpeg'
      );
    }

    if (detectedFormat !== format) {
      unlinkQuiet(tmpFilePath);
      throw new Error(
        `MEGA audio is ${detectedFormat}; requested ${format}. Conversion is disabled on this runtime.`
      );
    }

    return {
      stream: fs.createReadStream(tmpFilePath),
      mimeType: audioMime(detectedFormat),
      tmpFilePath,
    };
  }
}

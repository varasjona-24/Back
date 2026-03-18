import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import type {
  AudioFormat,
  DownloadQuality,
  MediaKind,
  VideoFormat,
} from '../../domain/usecases/types.js';

const DEFAULT_TIMEOUT_MS = 1000 * 60 * 30;
const AUDIO_FALLBACK_EXTS = ['m4a', 'mp3', 'aac', 'ogg', 'opus', 'flac', 'wav', 'webm'];
const VIDEO_FALLBACK_EXTS = ['mp4', 'mkv', 'webm', 'ts', 'm4v'];

export type AniDlDownloadInput = {
  url: string;
  kind: MediaKind;
  format: AudioFormat | VideoFormat;
  quality?: DownloadQuality;
};

export function isAniDlCommandConfigured(): boolean {
  return Boolean(process.env.ANIDL_CMD_TEMPLATE?.trim());
}

export function isAniDlEnabled(): boolean {
  const raw = (process.env.ANIDL_ENABLED ?? '').trim().toLowerCase();

  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return true;
  }

  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false;
  }

  // If explicit enable flag is not present, allow auto-enable when command is configured.
  return isAniDlCommandConfigured();
}

export function canHandleAniDlUrl(url: string): boolean {
  const host = safeHost(url);
  if (!host) return false;

  return (
    host.includes('crunchyroll.com') ||
    host.includes('hidive.com') ||
    host.includes('animationdigitalnetwork.') ||
    host.endsWith('adn.fr')
  );
}

export async function runAniDlDownload(input: AniDlDownloadInput): Promise<string> {
  const cmdTemplate = process.env.ANIDL_CMD_TEMPLATE?.trim();
  if (!cmdTemplate) {
    throw new Error(
      'ANIDL_CMD_TEMPLATE is required when ANIDL is enabled'
    );
  }

  const timeoutMs = parsePositiveInt(
    process.env.ANIDL_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  );
  const jobDir = path.resolve('tmp', 'anidl', `${Date.now()}-${randomUUID()}`);
  await fs.promises.mkdir(jobDir, { recursive: true });

  const vars = {
    url: input.url,
    outdir: jobDir,
    kind: input.kind,
    format: input.format,
    quality: input.quality ?? '',
  };

  const command = applyTemplate(cmdTemplate, vars);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANIDL_URL: vars.url,
    ANIDL_OUTDIR: vars.outdir,
    ANIDL_KIND: vars.kind,
    ANIDL_FORMAT: vars.format,
    ANIDL_QUALITY: vars.quality,
  };

  const run = await runProcess('/bin/sh', ['-lc', command], {
    cwd: process.cwd(),
    env,
    timeoutMs,
  });

  if (run.code !== 0) {
    const detail = summarizeStderr(run.stderr);
    throw new Error(
      detail
        ? `ANIDL command failed (code=${run.code}): ${detail}`
        : `ANIDL command failed (code=${run.code})`
    );
  }

  const expectedExt = String(input.format).toLowerCase();
  const fallbackExts = input.kind === 'audio'
    ? AUDIO_FALLBACK_EXTS
    : VIDEO_FALLBACK_EXTS;

  let downloadedFile = await findNewestFileByExt(jobDir, [expectedExt]);
  if (!downloadedFile) {
    downloadedFile = await findNewestFileByExt(jobDir, fallbackExts);
  }

  if (!downloadedFile) {
    throw new Error(
      `ANIDL finished without a downloadable ${input.kind} file in ${jobDir}`
    );
  }

  return ensureRequestedFormat(
    downloadedFile,
    input.kind,
    input.format,
    input.quality,
    timeoutMs
  );
}

type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

function runProcess(
  cmd: string,
  args: string[],
  options: RunProcessOptions = {}
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    const timeoutMs = options.timeoutMs ?? 0;
    let timeoutRef: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timeoutRef = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        reject(new Error(`${cmd} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.on('error', err => {
      if (timeoutRef) clearTimeout(timeoutRef);
      reject(err);
    });

    child.on('close', code => {
      if (timeoutRef) clearTimeout(timeoutRef);
      resolve({
        code: code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

async function ensureRequestedFormat(
  inputFilePath: string,
  kind: MediaKind,
  format: AudioFormat | VideoFormat,
  quality: DownloadQuality | undefined,
  timeoutMs: number
): Promise<string> {
  const currentExt = path.extname(inputFilePath).replace('.', '').toLowerCase();
  const targetExt = String(format).toLowerCase();

  if (currentExt === targetExt) {
    return inputFilePath;
  }

  const convertedPath = path.join(
    path.dirname(inputFilePath),
    `${path.basename(inputFilePath, path.extname(inputFilePath))}-converted.${targetExt}`
  );

  if (kind === 'audio') {
    const bitrate = mapAudioBitrate(quality);
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', inputFilePath,
      '-vn',
      ...(targetExt === 'mp3'
        ? ['-codec:a', 'libmp3lame']
        : ['-codec:a', 'aac']),
      '-b:a', bitrate,
      convertedPath,
    ];

    const result = await runProcess('ffmpeg', args, { timeoutMs });
    if (result.code !== 0 || !fs.existsSync(convertedPath)) {
      const detail = summarizeStderr(result.stderr);
      throw new Error(
        detail
          ? `ffmpeg audio conversion failed: ${detail}`
          : 'ffmpeg audio conversion failed'
      );
    }
  } else {
    const copyArgs = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', inputFilePath,
      '-c', 'copy',
      '-movflags', '+faststart',
      convertedPath,
    ];

    let result = await runProcess('ffmpeg', copyArgs, { timeoutMs });

    if (result.code !== 0 || !fs.existsSync(convertedPath)) {
      const transcodeArgs = [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-i', inputFilePath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        convertedPath,
      ];

      result = await runProcess('ffmpeg', transcodeArgs, { timeoutMs });
      if (result.code !== 0 || !fs.existsSync(convertedPath)) {
        const detail = summarizeStderr(result.stderr);
        throw new Error(
          detail
            ? `ffmpeg video conversion failed: ${detail}`
            : 'ffmpeg video conversion failed'
        );
      }
    }
  }

  fs.promises.unlink(inputFilePath).catch(() => {});
  return convertedPath;
}

async function findNewestFileByExt(
  dir: string,
  extensions: string[]
): Promise<string | null> {
  const normalized = new Set(extensions.map(ext => ext.toLowerCase()));
  const allFiles = await listFilesRecursive(dir);

  let bestPath: string | null = null;
  let bestMtime = -1;

  for (const filePath of allFiles) {
    const ext = path.extname(filePath).replace('.', '').toLowerCase();
    if (!normalized.has(ext)) continue;

    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) continue;

    if (stat.mtimeMs > bestMtime) {
      bestMtime = stat.mtimeMs;
      bestPath = filePath;
    }
  }

  return bestPath;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function mapAudioBitrate(quality: DownloadQuality | undefined): string {
  switch (quality) {
    case 'low':
      return '128k';
    case 'medium':
      return '192k';
    case 'high':
    default:
      return '320k';
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

  return parsed;
}

function applyTemplate(template: string, vars: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(vars)) {
    output = output.split(`{${key}}`).join(shellEscape(value));
  }
  return output;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function summarizeStderr(stderr: string): string {
  const clean = stderr.trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  return clean.length <= 450 ? clean : `${clean.slice(0, 450)}...`;
}

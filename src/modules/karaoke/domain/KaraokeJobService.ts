import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { mediaLibrary } from '../../media/domain/library/index.js';
import type { MediaVariant } from '../../media/domain/library/MediaVariant.js';

export type KaraokeJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled';

export type KaraokeJobInput = {
  mediaId?: string;
  title?: string;
  artist?: string;
  source?: string;
  sourcePath?: string;
};

export type KaraokeJobResult = {
  model: string;
  instrumentalPath: string;
  completedAt: number;
  durationMs: number;
};

export type KaraokeJob = {
  id: string;
  status: KaraokeJobStatus;
  progress: number;
  message: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  input: KaraokeJobInput;
  result?: KaraokeJobResult;
  error?: string;
};

type KaraokeJobServiceOptions = {
  mediaRoot?: string;
  jobsRoot?: string;
  ffmpegBin?: string;
  separationCmd?: string;
  demucsCmd?: string;
  demucsModel?: string;
  demucsEnabled?: boolean;
  demucsStrict?: boolean;
  separationTimeoutMs?: number;
  separationIdleTimeoutMs?: number;
  instrumentalTtlMs?: number;
  jobsTtlMs?: number;
  cleanupIntervalMs?: number;
  maxJobs?: number;
};

export class KaraokeJobService {
  private readonly jobs = new Map<string, KaraokeJob>();
  private readonly jobsRoot: string;
  private readonly ffmpegBin: string;
  private readonly separationCmd?: string;
  private readonly demucsCmd: string;
  private readonly demucsModel: string;
  private readonly demucsEnabled: boolean;
  private readonly demucsStrict: boolean;
  private readonly separationTimeoutMs: number;
  private readonly separationIdleTimeoutMs: number;
  private readonly instrumentalTtlMs: number;
  private readonly jobsTtlMs: number;
  private readonly maxJobs: number;
  private readonly cleanupInterval: NodeJS.Timeout;
  private readonly instrumentalExpiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: KaraokeJobServiceOptions = {}) {
    const mediaRoot = path.resolve(
      options.mediaRoot ?? process.env.MEDIA_PATH ?? 'media'
    );

    this.jobsRoot = path.resolve(options.jobsRoot ?? path.join(mediaRoot, 'karaoke-jobs'));
    this.ffmpegBin = options.ffmpegBin ?? process.env.KARAOKE_FFMPEG_BIN ?? 'ffmpeg';
    this.separationCmd = options.separationCmd ?? process.env.KARAOKE_SEPARATION_CMD;
    this.demucsModel =
      options.demucsModel?.trim() ||
      process.env.KARAOKE_DEMUCS_MODEL?.trim() ||
      'htdemucs_ft';
    const rawDemucsCmd =
      options.demucsCmd?.trim() ||
      process.env.KARAOKE_DEMUCS_CMD?.trim() ||
      `python3 -m demucs.separate -n ${this.demucsModel} --two-stems=vocals --device cpu --shifts 2 --segment 7 --overlap 0.25 -o {outdir} {input}`;
    this.demucsCmd = this.normalizeDemucsCmd(rawDemucsCmd);
    this.demucsEnabled =
      options.demucsEnabled ??
      this.readEnvBoolean('KARAOKE_DEMUCS_ENABLED', true);
    this.demucsStrict =
      options.demucsStrict ??
      this.readEnvBoolean('KARAOKE_DEMUCS_STRICT', false);
    this.separationTimeoutMs =
      options.separationTimeoutMs ??
      this.readEnvPositiveInt('KARAOKE_SEPARATION_TIMEOUT_MS', 15 * 60 * 1000);
    this.separationIdleTimeoutMs =
      options.separationIdleTimeoutMs ??
      this.readEnvPositiveInt('KARAOKE_SEPARATION_IDLE_TIMEOUT_MS', 2 * 60 * 1000);
    this.instrumentalTtlMs =
      options.instrumentalTtlMs ??
      this.readEnvPositiveInt('KARAOKE_INSTRUMENTAL_TTL_MS', 10 * 60 * 1000);
    this.jobsTtlMs = options.jobsTtlMs ?? this.readEnvPositiveInt('KARAOKE_JOBS_TTL_MS', 24 * 60 * 60 * 1000);
    this.maxJobs = options.maxJobs ?? this.readEnvPositiveInt('KARAOKE_JOBS_MAX', 200);

    fs.mkdirSync(this.jobsRoot, { recursive: true });

    const intervalMs = options.cleanupIntervalMs ?? 10 * 60 * 1000;
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredJobs();
    }, intervalMs);
    this.cleanupInterval.unref();
  }

  createJob(input: KaraokeJobInput): KaraokeJob {
    const normalized = this.normalizeInput(input);
    if (!normalized.mediaId && !normalized.sourcePath) {
      throw new Error('mediaId o sourcePath son requeridos');
    }

    const now = Date.now();
    const job: KaraokeJob = {
      id: uuidv4(),
      status: 'queued',
      progress: 0,
      message: 'Job en cola',
      createdAt: now,
      updatedAt: now,
      input: normalized,
    };

    this.jobs.set(job.id, job);
    this.trimJobsIfNeeded();

    void this.processJob(job.id);
    return this.cloneJob(job);
  }

  getJob(jobId: string): KaraokeJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? this.cloneJob(job) : undefined;
  }

  getInstrumentalPath(jobId: string): string | undefined {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'completed' || !job.result?.instrumentalPath) {
      return undefined;
    }
    if (!fs.existsSync(job.result.instrumentalPath)) {
      return undefined;
    }
    return job.result.instrumentalPath;
  }

  private async processJob(jobId: string): Promise<void> {
    const startedAt = Date.now();
    this.patchJob(jobId, {
      status: 'running',
      progress: 0.08,
      message: 'Preparando audio fuente...',
      startedAt,
      updatedAt: startedAt,
    });

    try {
      const job = this.jobs.get(jobId);
      if (!job) return;

      const sourcePath = this.resolveSourcePath(job.input);
      const jobDir = path.join(this.jobsRoot, jobId);
      fs.mkdirSync(jobDir, { recursive: true });
      let heartbeat: NodeJS.Timeout | null = null;

      const outputPath = path.join(jobDir, 'instrumental.wav');
      this.patchJob(jobId, {
        progress: 0.16,
        message: 'Separando voz e instrumental...',
        updatedAt: Date.now(),
      });

      const heartbeatStart = Date.now();
      heartbeat = setInterval(() => {
        const elapsedMs = Date.now() - heartbeatStart;
        const ratio = Math.min(1, elapsedMs / this.separationTimeoutMs);
        const progress = 0.16 + ratio * 0.72;
        const seconds = Math.floor(elapsedMs / 1000);
        this.patchJob(jobId, {
          progress: Math.min(0.88, progress),
          message: `Separando voz e instrumental... ${seconds}s`,
          updatedAt: Date.now(),
        });
      }, 3000);
      heartbeat.unref();

      let model: string;
      try {
        model = await this.runSeparation(sourcePath, outputPath);
      } finally {
        if (heartbeat != null) {
          clearInterval(heartbeat);
        }
      }

      if (!fs.existsSync(outputPath)) {
        throw new Error('No se generó archivo instrumental');
      }

      const stat = fs.statSync(outputPath);
      if (stat.size <= 0) {
        throw new Error('Archivo instrumental vacío');
      }

      const finishedAt = Date.now();
      this.patchJob(jobId, {
        status: 'completed',
        progress: 1,
        message: 'Separación completada',
        updatedAt: finishedAt,
        finishedAt,
        result: {
          model,
          instrumentalPath: outputPath,
          completedAt: finishedAt,
          durationMs: finishedAt - startedAt,
        },
      });
      this.scheduleInstrumentalExpiry(jobId, outputPath);
    } catch (error) {
      const finishedAt = Date.now();
      const message =
        error instanceof Error
          ? error.message
          : 'Fallo al procesar separación de karaoke';

      this.patchJob(jobId, {
        status: 'failed',
        progress: 1,
        message,
        updatedAt: finishedAt,
        finishedAt,
        error: message,
      });
    }
  }

  private resolveSourcePath(input: KaraokeJobInput): string {
    if (input.sourcePath) {
      const sourcePath = path.resolve(input.sourcePath);
      if (fs.existsSync(sourcePath)) {
        return sourcePath;
      }
      throw new Error('sourcePath no existe en disco');
    }

    if (!input.mediaId) {
      throw new Error('No se pudo resolver archivo fuente');
    }

    const variants = mediaLibrary.getVariants(input.mediaId);
    if (!variants.length) {
      throw new Error('Media sin variantes descargadas');
    }

    const sorted = variants
      .map(variant => ({
        variant,
        score: this.variantPriority(variant),
      }))
      .sort((a, b) => b.score - a.score);

    for (const candidate of sorted) {
      const resolved = path.resolve(candidate.variant.path);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }

    throw new Error('No se encontró archivo fuente local para el mediaId');
  }

  private variantPriority(variant: MediaVariant): number {
    let score = 0;
    if (variant.kind === 'audio') score += 100;
    if (variant.kind === 'video') score += 30;
    if (variant.format === 'mp3') score += 20;
    if (variant.format === 'm4a') score += 15;
    return score;
  }

  private async runSeparation(
    inputPath: string,
    outputPath: string
  ): Promise<string> {
    if (this.separationCmd?.trim()) {
      await this.runExternalCommand(
        this.separationCmd,
        {
          input: inputPath,
          output: outputPath,
        },
        'separación IA',
        { timeoutMs: this.separationTimeoutMs }
      );
      return 'external_command';
    }

    if (this.demucsEnabled && this.demucsCmd.trim() !== '') {
      try {
        await this.runDemucsCommand(inputPath, outputPath);
        return `demucs_${this.demucsModel}`;
      } catch (error) {
        if (this.demucsStrict) {
          throw error;
        }
        const reason =
          error instanceof Error ? error.message : String(error);
        console.warn(
          `[karaoke] Demucs falló, usando fallback ffmpeg: ${reason}`
        );
      }
    }

    await this.runFfmpegFallback(inputPath, outputPath);
    return 'ffmpeg_center_cancel';
  }

  private runExternalCommand(
    template: string,
    vars: Record<string, string>,
    label: string,
    options?: SpawnCommandOptions
  ): Promise<void> {
    let command = template.trim();
    for (const [key, value] of Object.entries(vars)) {
      command = command
        .split(`{${key}}`)
        .join(this.shellEscape(value));
    }

    return this.runSpawnCommand('/bin/sh', ['-lc', command], label, options);
  }

  private runFfmpegFallback(inputPath: string, outputPath: string): Promise<void> {
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-vn',
      '-af',
      'aformat=channel_layouts=stereo,pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c1-0.5*c0',
      '-ac',
      '2',
      '-ar',
      '44100',
      outputPath,
    ];

    return this.runSpawnCommand(this.ffmpegBin, args, 'ffmpeg separation', {
      timeoutMs: this.separationTimeoutMs,
    });
  }

  private async runDemucsCommand(
    inputPath: string,
    outputPath: string
  ): Promise<void> {
    const tmpDir = path.join(path.dirname(outputPath), `demucs_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      await this.runExternalCommand(
        this.demucsCmd,
        {
          input: inputPath,
          output: outputPath,
          outdir: tmpDir,
          model: this.demucsModel,
        },
        'demucs separation',
        {
          timeoutMs: Math.max(this.separationTimeoutMs, 30 * 60 * 1000),
          idleTimeoutMs: this.separationIdleTimeoutMs,
        }
      );

      const stemPath = this.findDemucsNoVocals(tmpDir);
      if (!stemPath) {
        throw new Error('Demucs no generó no_vocals.');
      }

      const args = [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        stemPath,
        '-ac',
        '2',
        '-ar',
        '44100',
        outputPath,
      ];
      await this.runSpawnCommand(this.ffmpegBin, args, 'demucs normalize', {
        timeoutMs: Math.min(2 * 60 * 1000, this.separationTimeoutMs),
      });
    } finally {
      fs.rm(tmpDir, { recursive: true, force: true }, () => { });
    }
  }

  private findDemucsNoVocals(baseDir: string): string | undefined {
    if (!fs.existsSync(baseDir)) return undefined;

    const stack: string[] = [baseDir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;

      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (
          entry.isFile() &&
          /^no_vocals\.(wav|flac|mp3)$/i.test(entry.name)
        ) {
          return full;
        }
      }
    }

    return undefined;
  }

  private runSpawnCommand(
    binary: string,
    args: string[],
    label: string,
    options?: SpawnCommandOptions
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      const timeoutMs = options?.timeoutMs ?? 0;
      const idleTimeoutMs = options?.idleTimeoutMs ?? 0;
      let timeoutHandle: NodeJS.Timeout | null = null;
      let idleTimeoutHandle: NodeJS.Timeout | null = null;
      let settled = false;

      const clearTimers = () => {
        if (timeoutHandle != null) clearTimeout(timeoutHandle);
        if (idleTimeoutHandle != null) clearTimeout(idleTimeoutHandle);
      };

      const armIdleTimeout = () => {
        if (idleTimeoutMs <= 0 || settled) return;
        if (idleTimeoutHandle != null) clearTimeout(idleTimeoutHandle);
        idleTimeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          const detail = this.compactProcessDetail(stderr, stdout);
          try {
            child.kill('SIGTERM');
            setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch (_) { }
            }, 3000).unref();
          } catch (_) { }

          reject(
            new Error(
              detail
                ? `${label}: sin actividad tras ${Math.floor(
                  idleTimeoutMs / 1000
                )}s. ${detail}`
                : `${label}: sin actividad tras ${Math.floor(
                  idleTimeoutMs / 1000
                )}s.`
            )
          );
        }, idleTimeoutMs);
        idleTimeoutHandle.unref();
      };

      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += String(chunk);
        if (stdout.length > 3000) {
          stdout = stdout.slice(-3000);
        }
        armIdleTimeout();
      });

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += String(chunk);
        if (stderr.length > 6000) {
          stderr = stderr.slice(-6000);
        }
        armIdleTimeout();
      });

      child.on('error', (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(new Error(`${label}: ${error.message}`));
      });

      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (code === 0) {
          resolve();
          return;
        }

        const detail = this.compactProcessDetail(stderr, stdout);
        reject(
          new Error(
            detail
              ? `${label}: ${detail}`
              : `${label}: proceso terminó con código ${code ?? 'null'}`
          )
        );
      });

      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (idleTimeoutHandle != null) clearTimeout(idleTimeoutHandle);
          const detail = this.compactProcessDetail(stderr, stdout);
          try {
            child.kill('SIGTERM');
            setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch (_) { }
            }, 3000).unref();
          } catch (_) { }

          reject(
            new Error(
              detail
                ? `${label}: timeout tras ${Math.floor(timeoutMs / 1000)}s. ${detail}`
                : `${label}: timeout tras ${Math.floor(timeoutMs / 1000)}s.`
            )
          );
        }, timeoutMs);
        timeoutHandle.unref();
      }

      armIdleTimeout();
    });
  }

  private cleanupExpiredJobs(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs.entries()) {
      const reference = job.finishedAt ?? job.updatedAt;
      if (now - reference < this.jobsTtlMs) continue;
      this.jobs.delete(id);
      this.deleteJobArtifacts(id);
    }
  }

  private trimJobsIfNeeded(): void {
    if (this.jobs.size <= this.maxJobs) return;

    const jobsSorted = Array.from(this.jobs.values()).sort(
      (a, b) => a.updatedAt - b.updatedAt
    );
    const overflow = this.jobs.size - this.maxJobs;

    for (let i = 0; i < overflow; i += 1) {
      const target = jobsSorted[i];
      if (!target) continue;
      this.jobs.delete(target.id);
      this.deleteJobArtifacts(target.id);
    }
  }

  private deleteJobArtifacts(jobId: string): void {
    this.clearInstrumentalExpiryTimer(jobId);
    const dir = path.join(this.jobsRoot, jobId);
    fs.rm(dir, { recursive: true, force: true }, () => { });
  }

  private clearInstrumentalExpiryTimer(jobId: string): void {
    const timer = this.instrumentalExpiryTimers.get(jobId);
    if (!timer) return;
    clearTimeout(timer);
    this.instrumentalExpiryTimers.delete(jobId);
  }

  private scheduleInstrumentalExpiry(jobId: string, filePath: string): void {
    if (this.instrumentalTtlMs <= 0) return;
    this.clearInstrumentalExpiryTimer(jobId);

    const timer = setTimeout(() => {
      this.instrumentalExpiryTimers.delete(jobId);
      const job = this.jobs.get(jobId);
      if (!job?.result?.instrumentalPath) return;

      const expected = path.resolve(filePath);
      const current = path.resolve(job.result.instrumentalPath);
      if (current !== expected) return;

      try {
        fs.rmSync(current, { force: true });
      } catch (_) { }

      this.patchJob(jobId, {
        updatedAt: Date.now(),
        message: 'Instrumental expirado automáticamente tras TTL.',
      });
    }, this.instrumentalTtlMs);
    timer.unref();
    this.instrumentalExpiryTimers.set(jobId, timer);
  }

  private patchJob(jobId: string, patch: Partial<KaraokeJob>): void {
    const current = this.jobs.get(jobId);
    if (!current) return;

    this.jobs.set(jobId, {
      ...current,
      ...patch,
    });
  }

  private normalizeInput(input: KaraokeJobInput): KaraokeJobInput {
    const mediaId = input.mediaId?.trim();
    const sourcePath = input.sourcePath?.trim();
    const title = input.title?.trim();
    const artist = input.artist?.trim();
    const source = input.source?.trim();

    return {
      mediaId: mediaId || undefined,
      sourcePath: sourcePath || undefined,
      title: title || undefined,
      artist: artist || undefined,
      source: source || undefined,
    };
  }

  private cloneJob(job: KaraokeJob): KaraokeJob {
    return JSON.parse(JSON.stringify(job));
  }

  private shellEscape(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private readEnvPositiveInt(envName: string, fallback: number): number {
    const raw = process.env[envName];
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
  }

  private readEnvBoolean(envName: string, fallback: boolean): boolean {
    const raw = process.env[envName];
    if (!raw) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (
      normalized === '1' ||
      normalized === 'true' ||
      normalized === 'yes' ||
      normalized === 'on'
    ) {
      return true;
    }
    if (
      normalized === '0' ||
      normalized === 'false' ||
      normalized === 'no' ||
      normalized === 'off'
    ) {
      return false;
    }
    return fallback;
  }

  private normalizeDemucsCmd(template: string): string {
    let cmd = template.trim();
    if (cmd.length == 0) return cmd;

    const segmentRegex = /--segment\s+([0-9]*\.?[0-9]+)/i;
    const match = cmd.match(segmentRegex);
    if (match != null) {
      const segment = Number(match[1]);
      if (Number.isFinite(segment)) {
        if (segment > 7.8 || segment <= 0 || !Number.isInteger(segment)) {
          cmd = cmd.replace(segmentRegex, '--segment 7');
        }
      }
    } else {
      cmd = `${cmd} --segment 7`;
    }

    return cmd;
  }

  private compactProcessDetail(stderrRaw: string, stdoutRaw: string): string {
    const all = `${stderrRaw.trim()}\n${stdoutRaw.trim()}`
      .split(/\r?\n|\r/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (all.length === 0) return '';

    let preferred: string | undefined;
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const line = all[i];
      const lower = line.toLowerCase();
      if (
        lower.includes('error') ||
        lower.includes('fatal') ||
        lower.includes('exception')
      ) {
        preferred = line;
        break;
      }
    }

    preferred = preferred ?? this.lastNonProgressLine(all) ?? all[all.length - 1];
    if (preferred.length > 240) {
      return `${preferred.substring(0, 237)}...`;
    }
    return preferred;
  }

  private lastNonProgressLine(lines: string[]): string | undefined {
    const progressLike = /^\d+(\.\d+)?\/\d+(\.\d+)?/;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.includes('%|') || progressLike.test(line)) {
        continue;
      }
      return line;
    }
    return undefined;
  }
}

type SpawnCommandOptions = {
  timeoutMs?: number;
  idleTimeoutMs?: number;
};

export const karaokeJobService = new KaraokeJobService();

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

export type KaraokeSessionStatus =
  | 'separating'
  | 'ready_to_record'
  | 'mixing'
  | 'completed'
  | 'failed'
  | 'canceled';

export type KaraokeSessionInput = {
  mediaId?: string;
  title?: string;
  artist?: string;
  source?: string;
};

export type KaraokeSession = {
  id: string;
  status: KaraokeSessionStatus;
  progress: number;
  message: string;
  createdAt: number;
  updatedAt: number;
  input: KaraokeSessionInput;
  sourcePath: string;
  instrumentalPath?: string;
  voicePath?: string;
  mixPath?: string;
  separatorModel: string;
  error?: string;
};

type CreateSessionInput = {
  sourceBytes: Buffer;
  sourceFilename?: string;
  input: KaraokeSessionInput;
};

type MixInput = {
  voiceBytes: Buffer;
  voiceFilename?: string;
  voiceGain: number;
  instrumentalGain: number;
};

type KaraokeSessionServiceOptions = {
  mediaRoot?: string;
  sessionsRoot?: string;
  ffmpegBin?: string;
  separationCmd?: string;
  demucsCmd?: string;
  demucsModel?: string;
  demucsEnabled?: boolean;
  demucsStrict?: boolean;
  mixCmd?: string;
  separationTimeoutMs?: number;
  separationIdleTimeoutMs?: number;
  instrumentalTtlMs?: number;
  sessionsTtlMs?: number;
  cleanupIntervalMs?: number;
  maxSessions?: number;
};

export class KaraokeSessionService {
  private readonly sessions = new Map<string, KaraokeSession>();
  private readonly sessionsRoot: string;
  private readonly ffmpegBin: string;
  private readonly separationCmd?: string;
  private readonly demucsCmd: string;
  private readonly demucsModel: string;
  private readonly demucsEnabled: boolean;
  private readonly demucsStrict: boolean;
  private readonly mixCmd?: string;
  private readonly separationTimeoutMs: number;
  private readonly separationIdleTimeoutMs: number;
  private readonly instrumentalTtlMs: number;
  private readonly sessionsTtlMs: number;
  private readonly maxSessions: number;
  private readonly cleanupInterval: NodeJS.Timeout;
  private readonly instrumentalExpiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: KaraokeSessionServiceOptions = {}) {
    const mediaRoot = path.resolve(
      options.mediaRoot ?? process.env.MEDIA_PATH ?? 'media'
    );
    this.sessionsRoot = path.resolve(
      options.sessionsRoot ?? path.join(mediaRoot, 'karaoke-sessions')
    );
    this.ffmpegBin = options.ffmpegBin ?? process.env.KARAOKE_FFMPEG_BIN ?? 'ffmpeg';
    this.separationCmd =
      options.separationCmd ?? process.env.KARAOKE_SEPARATION_CMD;
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
    this.mixCmd = options.mixCmd ?? process.env.KARAOKE_MIX_CMD;
    this.separationTimeoutMs =
      options.separationTimeoutMs ??
      this.readEnvPositiveInt('KARAOKE_SEPARATION_TIMEOUT_MS', 15 * 60 * 1000);
    this.separationIdleTimeoutMs =
      options.separationIdleTimeoutMs ??
      this.readEnvPositiveInt('KARAOKE_SEPARATION_IDLE_TIMEOUT_MS', 2 * 60 * 1000);
    this.instrumentalTtlMs =
      options.instrumentalTtlMs ??
      this.readEnvPositiveInt('KARAOKE_INSTRUMENTAL_TTL_MS', 10 * 60 * 1000);
    this.sessionsTtlMs =
      options.sessionsTtlMs ??
      this.readEnvPositiveInt('KARAOKE_SESSIONS_TTL_MS', 24 * 60 * 60 * 1000);
    this.maxSessions =
      options.maxSessions ??
      this.readEnvPositiveInt('KARAOKE_SESSIONS_MAX', 120);

    fs.mkdirSync(this.sessionsRoot, { recursive: true });

    const intervalMs = options.cleanupIntervalMs ?? 10 * 60 * 1000;
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, intervalMs);
    this.cleanupInterval.unref();
  }

  createSessionFromUpload(input: CreateSessionInput): KaraokeSession {
    if (!input.sourceBytes.length) {
      throw new Error('Audio fuente vacío');
    }

    const sessionId = uuidv4();
    const now = Date.now();
    const sessionDir = this.getSessionDir(sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const sourceExt = this.extensionFromName(input.sourceFilename, 'audio');
    const sourcePath = path.join(sessionDir, `source.${sourceExt}`);
    fs.writeFileSync(sourcePath, input.sourceBytes);

    const model = this.resolvePreferredSeparationModel();
    const session: KaraokeSession = {
      id: sessionId,
      status: 'separating',
      progress: 0.04,
      message: 'Subida recibida. Preparando separación...',
      createdAt: now,
      updatedAt: now,
      input: this.normalizeInput(input.input),
      sourcePath,
      separatorModel: model,
    };

    this.sessions.set(session.id, session);
    this.trimSessionsIfNeeded();
    void this.runSeparation(session.id);

    return this.cloneSession(session);
  }

  private resolvePreferredSeparationModel(): string {
    if (this.separationCmd?.trim()) {
      return 'external_ai_command';
    }
    if (this.demucsEnabled && this.demucsCmd.trim() !== '') {
      return `demucs_${this.demucsModel}`;
    }
    return 'ffmpeg_center_cancel';
  }

  getSession(sessionId: string): KaraokeSession | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.cloneSession(session) : undefined;
  }

  getInstrumentalPath(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (
      (session.status === 'ready_to_record' || session.status === 'completed') &&
      session.instrumentalPath
    ) {
      if (!fs.existsSync(session.instrumentalPath)) {
        this.patchSession(sessionId, {
          instrumentalPath: undefined,
          message: 'Instrumental expirado. Genera uno nuevo.',
          updatedAt: Date.now(),
        });
        return undefined;
      }
      return session.instrumentalPath;
    }
    return undefined;
  }

  getMixPath(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'completed' || !session.mixPath) {
      return undefined;
    }
    return session.mixPath;
  }

  async uploadVoiceAndMix(
    sessionId: string,
    input: MixInput
  ): Promise<KaraokeSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Sesión no encontrada');
    }

    if (!input.voiceBytes.length) {
      throw new Error('Audio de voz vacío');
    }

    if (
      session.status !== 'ready_to_record' &&
      session.status !== 'completed' &&
      session.status !== 'failed'
    ) {
      throw new Error('La sesión aún no está lista para mezclar');
    }

    if (!session.instrumentalPath || !fs.existsSync(session.instrumentalPath)) {
      throw new Error('Instrumental no disponible para mezcla');
    }

    const sessionDir = this.getSessionDir(session.id);
    fs.mkdirSync(sessionDir, { recursive: true });

    const voiceExt = this.extensionFromName(input.voiceFilename, 'voice');
    const voicePath = path.join(sessionDir, `voice_${Date.now()}.${voiceExt}`);
    fs.writeFileSync(voicePath, input.voiceBytes);

    const mixPath = path.join(sessionDir, `mix_${Date.now()}.wav`);
    this.patchSession(session.id, {
      status: 'mixing',
      progress: 0.62,
      message: 'Mezclando voz con instrumental...',
      updatedAt: Date.now(),
      voicePath,
      mixPath: undefined,
      error: undefined,
    });

    try {
      await this.runMixCommand(
        session.instrumentalPath,
        voicePath,
        mixPath,
        input.voiceGain,
        input.instrumentalGain
      );

      if (!fs.existsSync(mixPath)) {
        throw new Error('No se generó la mezcla final');
      }

      const stat = fs.statSync(mixPath);
      if (stat.size <= 0) {
        throw new Error('Mezcla final vacía');
      }

      const doneAt = Date.now();
      this.patchSession(session.id, {
        status: 'completed',
        progress: 1,
        message: 'Mezcla final lista',
        updatedAt: doneAt,
        mixPath,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error en mezcla de karaoke';
      this.patchSession(session.id, {
        status: 'failed',
        progress: 1,
        message,
        updatedAt: Date.now(),
        error: message,
      });
    }

    const updated = this.sessions.get(session.id);
    if (!updated) {
      throw new Error('La sesión se perdió durante el proceso');
    }
    return this.cloneSession(updated);
  }

  private async runSeparation(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const sessionDir = this.getSessionDir(sessionId);
    const instrumentalPath = path.join(sessionDir, 'instrumental.wav');
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const ratio = Math.min(1, elapsedMs / this.separationTimeoutMs);
      const progress = 0.18 + ratio * 0.7;
      const seconds = Math.floor(elapsedMs / 1000);
      this.patchSession(sessionId, {
        progress: Math.min(0.88, progress),
        message: `Separando voces e instrumental... ${seconds}s`,
        updatedAt: Date.now(),
      });
    }, 3000);
    heartbeat.unref();
    this.patchSession(sessionId, {
      progress: 0.18,
      message: 'Separando voces e instrumental...',
      updatedAt: Date.now(),
    });

    try {
      const usedModel = await this.runSeparationCommand(
        session.sourcePath,
        instrumentalPath
      );

      if (!fs.existsSync(instrumentalPath)) {
        throw new Error('No se generó pista instrumental');
      }

      const stat = fs.statSync(instrumentalPath);
      if (stat.size <= 0) {
        throw new Error('Pista instrumental vacía');
      }

      this.patchSession(sessionId, {
        status: 'ready_to_record',
        progress: 1,
        message: usedModel.startsWith('demucs_')
          ? 'Instrumental IA listo para grabar voz'
          : 'Instrumental listo (fallback no IA)',
        updatedAt: Date.now(),
        instrumentalPath,
        separatorModel: usedModel,
      });
      this.scheduleInstrumentalExpiry(sessionId, instrumentalPath);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Error al separar instrumental';
      this.patchSession(sessionId, {
        status: 'failed',
        progress: 1,
        message,
        updatedAt: Date.now(),
        error: message,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async runSeparationCommand(
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
      return 'external_ai_command';
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

    await this.runFfmpegSeparation(inputPath, outputPath);
    return 'ffmpeg_center_cancel';
  }

  private runFfmpegSeparation(
    inputPath: string,
    outputPath: string
  ): Promise<void> {
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
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
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

  private runMixCommand(
    instrumentalPath: string,
    voicePath: string,
    outputPath: string,
    voiceGainRaw: number,
    instrumentalGainRaw: number
  ): Promise<void> {
    const voiceGain = this.sanitizeGain(voiceGainRaw, 1.0);
    const instrumentalGain = this.sanitizeGain(instrumentalGainRaw, 0.85);

    if (this.mixCmd?.trim()) {
      return this.runExternalCommand(
        this.mixCmd,
        {
          instrumental: instrumentalPath,
          voice: voicePath,
          output: outputPath,
          voiceGain: voiceGain.toString(),
          instrumentalGain: instrumentalGain.toString(),
        },
        'mezcla'
      );
    }

    const filter = [
      '[0:a]volume=' + instrumentalGain.toFixed(3) + '[inst]',
      '[1:a]highpass=f=90,lowpass=f=9000,acompressor=threshold=-18dB:ratio=3.0:attack=6:release=80,volume=' +
          voiceGain.toFixed(3) +
          '[vox]',
      '[inst][vox]amix=inputs=2:duration=longest:dropout_transition=2,alimiter=limit=0.95[out]',
    ].join(';');

    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      instrumentalPath,
      '-i',
      voicePath,
      '-filter_complex',
      filter,
      '-map',
      '[out]',
      '-ac',
      '2',
      '-ar',
      '44100',
      outputPath,
    ];

    return this.runSpawnCommand(this.ffmpegBin, args, 'ffmpeg mix');
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
              } catch (_) {}
            }, 3000).unref();
          } catch (_) {}

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
              } catch (_) {}
            }, 3000).unref();
          } catch (_) {}

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

  private sanitizeGain(raw: number, fallback: number): number {
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(2.5, Math.max(0.0, raw));
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.updatedAt < this.sessionsTtlMs) continue;
      this.sessions.delete(id);
      this.deleteSessionArtifacts(id);
    }
  }

  private trimSessionsIfNeeded(): void {
    if (this.sessions.size <= this.maxSessions) return;
    const sorted = Array.from(this.sessions.values()).sort(
      (a, b) => a.updatedAt - b.updatedAt
    );

    const overflow = this.sessions.size - this.maxSessions;
    for (let i = 0; i < overflow; i += 1) {
      const session = sorted[i];
      if (!session) continue;
      this.sessions.delete(session.id);
      this.deleteSessionArtifacts(session.id);
    }
  }

  private patchSession(
    sessionId: string,
    patch: Partial<KaraokeSession>
  ): void {
    const current = this.sessions.get(sessionId);
    if (!current) return;

    this.sessions.set(sessionId, {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? Date.now(),
    });
  }

  private getSessionDir(sessionId: string): string {
    return path.join(this.sessionsRoot, sessionId);
  }

  private deleteSessionArtifacts(sessionId: string): void {
    this.clearInstrumentalExpiryTimer(sessionId);
    const dir = this.getSessionDir(sessionId);
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }

  private clearInstrumentalExpiryTimer(sessionId: string): void {
    const timer = this.instrumentalExpiryTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.instrumentalExpiryTimers.delete(sessionId);
  }

  private scheduleInstrumentalExpiry(
    sessionId: string,
    instrumentalPath: string
  ): void {
    if (this.instrumentalTtlMs <= 0) return;
    this.clearInstrumentalExpiryTimer(sessionId);

    const timer = setTimeout(() => {
      this.instrumentalExpiryTimers.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (!session || !session.instrumentalPath) return;

      const expected = path.resolve(instrumentalPath);
      const current = path.resolve(session.instrumentalPath);
      if (current !== expected) return;

      try {
        fs.rmSync(current, { force: true });
      } catch (_) {}

      this.patchSession(sessionId, {
        instrumentalPath: undefined,
        message: 'Instrumental expirado automáticamente tras TTL.',
        updatedAt: Date.now(),
      });
    }, this.instrumentalTtlMs);
    timer.unref();
    this.instrumentalExpiryTimers.set(sessionId, timer);
  }

  private normalizeInput(input: KaraokeSessionInput): KaraokeSessionInput {
    const mediaId = input.mediaId?.trim();
    const title = input.title?.trim();
    const artist = input.artist?.trim();
    const source = input.source?.trim();
    return {
      mediaId: mediaId || undefined,
      title: title || undefined,
      artist: artist || undefined,
      source: source || undefined,
    };
  }

  private extensionFromName(name: string | undefined, mode: 'audio' | 'voice'): string {
    const fallback = mode === 'voice' ? 'm4a' : 'wav';
    if (!name) return fallback;
    const clean = name.split('?')[0].trim();
    const dot = clean.lastIndexOf('.');
    if (dot < 0 || dot >= clean.length - 1) return fallback;
    const ext = clean.substring(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!ext) return fallback;
    if (ext.length > 8) return fallback;
    return ext;
  }

  private shellEscape(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private cloneSession(session: KaraokeSession): KaraokeSession {
    return JSON.parse(JSON.stringify(session));
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

    // This Demucs CLI expects integer segment values and transformer models
    // fail above ~7.8s. Clamp to safe integer value.
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

export const karaokeSessionService = new KaraokeSessionService();

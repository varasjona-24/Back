import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { ApiErrorCode, apiError } from '../../../shared/apiErrors.js';

export type KaraokeSessionStatus =
  | 'separating'
  | 'ready_to_record'
  | 'mixing'
  | 'completed'
  | 'failed'
  | 'canceled';

export type KaraokeVariantMode = 'instrumental' | 'spatial8d';

export type KaraokeSessionInput = {
  mediaId?: string;
  title?: string;
  artist?: string;
  source?: string;
};

export type KaraokeSession = {
  id: string;
  mode: KaraokeVariantMode;
  status: KaraokeSessionStatus;
  progress: number;
  message: string;
  createdAt: number;
  updatedAt: number;
  input: KaraokeSessionInput;
  sourcePath: string;
  instrumentalPath?: string;
  instrumentalExpiresAt?: number;
  spatial8dPath?: string;
  spatial8dExpiresAt?: number;
  voicePath?: string;
  mixPath?: string;
  separatorModel: string;
  error?: string;
  errorCode?: ApiErrorCode;
  retryable?: boolean;
  retryAfterSeconds?: number;
};

type CreateSessionInput = {
  sourceBytes: Buffer;
  sourceFilename?: string;
  input: KaraokeSessionInput;
  mode?: KaraokeVariantMode;
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
  spatialCmd?: string;
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
  maxActiveSessions?: number;
};

type DetectedAudioUpload = {
  ext: string;
  mime: string;
};

type KaraokeSessionFailure = {
  code: ApiErrorCode;
  userMessage: string;
  retryable: boolean;
  retryAfterSeconds?: number;
};

const ALLOWED_SOURCE_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'aac', 'flac']);

export class KaraokeSessionService {
  private readonly sessions = new Map<string, KaraokeSession>();
  private readonly sessionsRoot: string;
  private readonly ffmpegBin: string;
  private readonly separationCmd?: string;
  private readonly spatialCmd?: string;
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
  private readonly maxActiveSessions: number;
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
    this.spatialCmd = options.spatialCmd ?? process.env.KARAOKE_SPATIAL8D_CMD;
    this.demucsModel =
      options.demucsModel?.trim() ||
      process.env.KARAOKE_DEMUCS_MODEL?.trim() ||
      'htdemucs';
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
    this.maxActiveSessions =
      options.maxActiveSessions ??
      this.readEnvPositiveInt('KARAOKE_ACTIVE_SESSIONS_MAX', 3);

    fs.mkdirSync(this.sessionsRoot, { recursive: true });

    const intervalMs = options.cleanupIntervalMs ?? 10 * 60 * 1000;
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, intervalMs);
    this.cleanupInterval.unref();
  }

  createSessionFromUpload(input: CreateSessionInput): KaraokeSession {
    if (!input.sourceBytes.length) {
      throw apiError({
        code: 'KARAOKE_INVALID_AUDIO_BYTES',
        message: 'Source audio is empty.',
        userMessage: 'El audio fuente está vacío.',
        status: 400,
        retryable: false,
      });
    }

    this.assertActiveSessionQuota();
    const sourceAudio = this.validateSourceUpload(
      input.sourceBytes,
      input.sourceFilename
    );

    const sessionId = uuidv4();
    const now = Date.now();
    const sessionDir = this.getSessionDir(sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const sourcePath = path.join(sessionDir, `source.${sourceAudio.ext}`);
    fs.writeFileSync(sourcePath, input.sourceBytes);

    const mode = this.normalizeMode(input.mode);
    const model = this.resolvePreferredSeparationModel(mode);
    const session: KaraokeSession = {
      id: sessionId,
      mode,
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

  private resolvePreferredSeparationModel(mode: KaraokeVariantMode): string {
    if (mode === 'spatial8d') {
      if (this.spatialCmd?.trim()) {
        return 'external_spatial8d_command';
      }
      return 'ffmpeg_spatial8d';
    }
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
    return this.getModeOutputPath(sessionId, 'instrumental');
  }

  getSpatial8dPath(sessionId: string): string | undefined {
    return this.getModeOutputPath(sessionId, 'spatial8d');
  }

  private getModeOutputPath(
    sessionId: string,
    mode: KaraokeVariantMode
  ): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.mode !== mode) return undefined;

    const outputPath = this.outputPathByMode(session, mode);
    const expiresAt = this.outputExpiryByMode(session, mode);

    if (expiresAt && Date.now() >= expiresAt) {
      this.removeSession(sessionId);
      return undefined;
    }

    if (
      (session.status === 'ready_to_record' || session.status === 'completed') &&
      outputPath
    ) {
      if (!fs.existsSync(outputPath)) {
        if (mode === 'instrumental') {
          this.patchSession(sessionId, {
            instrumentalPath: undefined,
            message: 'Instrumental expirado. Genera uno nuevo.',
            updatedAt: Date.now(),
          });
        } else {
          this.patchSession(sessionId, {
            spatial8dPath: undefined,
            message: 'Audio 8D expirado. Genera uno nuevo.',
            updatedAt: Date.now(),
          });
        }
        return undefined;
      }
      return outputPath;
    }
    return undefined;
  }

  markInstrumentalServed(sessionId: string): void {
    this.markModeOutputServed(sessionId, 'instrumental');
  }

  markSpatial8dServed(sessionId: string): void {
    this.markModeOutputServed(sessionId, 'spatial8d');
  }

  private markModeOutputServed(
    sessionId: string,
    mode: KaraokeVariantMode
  ): void {
    if (this.instrumentalTtlMs <= 0) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.mode !== mode) return;
    if (
      session.status !== 'ready_to_record' &&
      session.status !== 'completed'
    ) {
      return;
    }

    const outputPath = this.outputPathByMode(session, mode);
    if (!outputPath) return;

    const now = Date.now();
    const currentExpiresAt = this.outputExpiryByMode(session, mode);
    if (currentExpiresAt && now < currentExpiresAt) {
      return;
    }

    const expiresAt = now + this.instrumentalTtlMs;
    if (mode === 'instrumental') {
      this.patchSession(sessionId, {
        instrumentalExpiresAt: expiresAt,
        updatedAt: now,
      });
    } else {
      this.patchSession(sessionId, {
        spatial8dExpiresAt: expiresAt,
        updatedAt: now,
      });
    }

    this.scheduleOutputExpiry(sessionId, mode, outputPath, expiresAt);
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
    const outputPath =
      session.mode === 'spatial8d'
        ? path.join(sessionDir, 'spatial8d.wav')
        : path.join(sessionDir, 'instrumental.wav');
    const progressLabel =
      session.mode === 'spatial8d'
        ? 'Procesando audio 8D...'
        : 'Separando voces e instrumental...';
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const ratio = Math.min(1, elapsedMs / this.separationTimeoutMs);
      const progress = 0.18 + ratio * 0.7;
      const seconds = Math.floor(elapsedMs / 1000);
      this.patchSession(sessionId, {
        progress: Math.min(0.88, progress),
        message: `${progressLabel} ${seconds}s`,
        updatedAt: Date.now(),
      });
    }, 3000);
    heartbeat.unref();
    this.patchSession(sessionId, {
      progress: 0.18,
      message: progressLabel,
      updatedAt: Date.now(),
    });

    try {
      const usedModel = await this.runSeparationCommand(
        session.mode,
        session.sourcePath,
        outputPath
      );

      if (!fs.existsSync(outputPath)) {
        throw new Error(
          session.mode === 'spatial8d'
            ? 'No se generó audio 8D'
            : 'No se generó pista instrumental'
        );
      }

      const stat = fs.statSync(outputPath);
      if (stat.size <= 0) {
        throw new Error(
          session.mode === 'spatial8d'
            ? 'Audio 8D vacío'
            : 'Pista instrumental vacía'
        );
      }

      this.patchSession(sessionId, {
        status: 'ready_to_record',
        progress: 1,
        message: session.mode === 'spatial8d'
          ? 'Audio 8D listo para reproducir'
          : usedModel.startsWith('demucs_')
          ? 'Instrumental IA listo para grabar voz'
          : 'Instrumental listo (fallback no IA)',
        updatedAt: Date.now(),
        instrumentalPath:
            session.mode === 'instrumental' ? outputPath : undefined,
        instrumentalExpiresAt:
            session.mode === 'instrumental' ? undefined : session.instrumentalExpiresAt,
        spatial8dPath: session.mode === 'spatial8d' ? outputPath : undefined,
        spatial8dExpiresAt:
            session.mode === 'spatial8d' ? undefined : session.spatial8dExpiresAt,
        separatorModel: usedModel,
        error: undefined,
      });
    } catch (error) {
      const failure = this.classifySeparationFailure(error, session.mode);
      this.patchSession(sessionId, {
        status: 'failed',
        progress: 1,
        message: failure.userMessage,
        updatedAt: Date.now(),
        error: failure.userMessage,
        errorCode: failure.code,
        retryable: failure.retryable,
        retryAfterSeconds: failure.retryAfterSeconds,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async runSeparationCommand(
    mode: KaraokeVariantMode,
    inputPath: string,
    outputPath: string
  ): Promise<string> {
    if (mode === 'spatial8d') {
      if (this.spatialCmd?.trim()) {
        await this.runExternalCommand(
          this.spatialCmd,
          {
            input: inputPath,
            output: outputPath,
          },
          'spatial 8d',
          { timeoutMs: this.separationTimeoutMs }
        );
        return 'external_spatial8d_command';
      }

      await this.runSpatial8dCommand(inputPath, outputPath);
      return 'ffmpeg_spatial8d';
    }

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

  private runSpatial8dCommand(
    inputPath: string,
    outputPath: string
  ): Promise<void> {
    // 8D "concierto": mezcla de señal seca + paneo + ambiente corto.
    const filter = [
      'aformat=channel_layouts=stereo,highpass=f=32,lowpass=f=17800,asplit=3[dry][move][amb]',
      '[move]apulsator=hz=0.065:amount=0.88:mode=sine:offset_l=0:offset_r=0.5,volume=0.95[move8d]',
      '[amb]aecho=0.82:0.58:28|62|118:0.28|0.20|0.12,lowpass=f=9200,volume=0.34[hall]',
      '[dry]volume=1.0[dry0]',
      '[dry0][move8d][hall]amix=inputs=3:normalize=0,alimiter=limit=0.96',
    ].join(';');

    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-vn',
      '-af',
      filter,
      '-ac',
      '2',
      '-ar',
      '44100',
      outputPath,
    ];

    return this.runSpawnCommand(this.ffmpegBin, args, 'ffmpeg spatial8d', {
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

  private classifySeparationFailure(
    error: unknown,
    mode: KaraokeVariantMode
  ): KaraokeSessionFailure {
    const raw = error instanceof Error ? error.message : String(error);
    const lower = raw.toLowerCase();
    const noun = mode === 'spatial8d' ? 'audio 8D' : 'instrumental';

    if (lower.includes('timeout') || lower.includes('sin actividad')) {
      return {
        code: 'KARAOKE_PROCESS_TIMEOUT',
        userMessage:
          `El backend tardó demasiado procesando el ${noun}. Reintenta con un audio más corto o vuelve a intentarlo en unos minutos.`,
        retryable: true,
        retryAfterSeconds: 120,
      };
    }

    return {
      code: 'KARAOKE_PROCESS_FAILED',
      userMessage:
        mode === 'spatial8d'
          ? 'No se pudo generar el audio 8D en el backend.'
          : 'No se pudo separar el instrumental en el backend.',
      retryable: true,
      retryAfterSeconds: 60,
    };
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.updatedAt < this.sessionsTtlMs) continue;
      this.removeSession(id);
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
      this.removeSession(session.id);
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

  private removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.deleteSessionArtifacts(sessionId);
  }

  private deleteSessionArtifacts(sessionId: string): void {
    this.clearOutputExpiryTimer(sessionId);
    const dir = this.getSessionDir(sessionId);
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }

  private clearOutputExpiryTimer(sessionId: string): void {
    const timer = this.instrumentalExpiryTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.instrumentalExpiryTimers.delete(sessionId);
  }

  private scheduleOutputExpiry(
    sessionId: string,
    mode: KaraokeVariantMode,
    outputPath: string,
    expiresAt: number
  ): void {
    if (this.instrumentalTtlMs <= 0) return;
    this.clearOutputExpiryTimer(sessionId);

    const delay = Math.max(0, expiresAt - Date.now());
    const timer = setTimeout(() => {
      this.instrumentalExpiryTimers.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (!session) return;
      if (session.mode !== mode) return;
      const currentPath = this.outputPathByMode(session, mode);
      if (!currentPath) return;
      const currentExpiresAt = this.outputExpiryByMode(session, mode);
      if (currentExpiresAt !== expiresAt) return;
      if (Date.now() < expiresAt) return;

      const expected = path.resolve(outputPath);
      const current = path.resolve(currentPath);
      if (current !== expected) return;

      // TTL vencido: limpiar sesión completa (source + output + mix).
      this.removeSession(sessionId);
    }, delay);
    timer.unref();
    this.instrumentalExpiryTimers.set(sessionId, timer);
  }

  private outputPathByMode(
    session: KaraokeSession,
    mode: KaraokeVariantMode
  ): string | undefined {
    return mode === 'instrumental'
      ? session.instrumentalPath
      : session.spatial8dPath;
  }

  private outputExpiryByMode(
    session: KaraokeSession,
    mode: KaraokeVariantMode
  ): number | undefined {
    return mode === 'instrumental'
      ? session.instrumentalExpiresAt
      : session.spatial8dExpiresAt;
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

  private normalizeMode(raw: KaraokeVariantMode | undefined): KaraokeVariantMode {
    return raw === 'spatial8d' ? 'spatial8d' : 'instrumental';
  }

  private assertActiveSessionQuota(): void {
    const active = Array.from(this.sessions.values()).filter(session =>
      session.status === 'separating' || session.status === 'mixing'
    );

    if (active.length >= this.maxActiveSessions) {
      throw apiError({
        code: 'KARAOKE_BACKEND_BUSY',
        message: `Active karaoke session limit reached: ${active.length}.`,
        userMessage:
          'El backend está procesando varias sesiones. Reintenta en unos minutos.',
        status: 429,
        retryable: true,
        retryAfterSeconds: 120,
        details: {
          activeSessions: active.length,
          maxActiveSessions: this.maxActiveSessions,
        },
      });
    }
  }

  private validateSourceUpload(
    bytes: Buffer,
    filename: string | undefined
  ): DetectedAudioUpload {
    const detected = this.detectAudioUpload(bytes);
    if (!detected) {
      throw apiError({
        code: 'KARAOKE_INVALID_AUDIO_BYTES',
        message: 'Uploaded file does not match a supported audio signature.',
        userMessage: 'El archivo subido no parece ser un audio compatible.',
        status: 400,
        retryable: false,
        details: {
          allowedFormats: Array.from(ALLOWED_SOURCE_EXTENSIONS),
        },
      });
    }

    const rawExt = this.extensionFromName(filename, 'audio', '');
    const ext = rawExt || detected.ext;

    if (!ALLOWED_SOURCE_EXTENSIONS.has(ext)) {
      throw apiError({
        code: 'KARAOKE_UNSUPPORTED_AUDIO_FORMAT',
        message: `Unsupported karaoke source audio extension: ${ext || 'unknown'}.`,
        userMessage:
          'Este archivo no es compatible. Usa WAV, MP3, M4A, AAC o FLAC.',
        status: 400,
        retryable: false,
        details: {
          extension: ext || null,
          allowedFormats: Array.from(ALLOWED_SOURCE_EXTENSIONS),
        },
      });
    }

    if (detected.ext !== ext) {
      const compatible =
        (ext === 'm4a' && detected.ext === 'aac') ||
        (ext === 'aac' && detected.ext === 'm4a');
      if (!compatible) {
        throw apiError({
          code: 'KARAOKE_AUDIO_EXTENSION_MISMATCH',
          message: `Audio extension .${ext} does not match detected content ${detected.mime}.`,
          userMessage:
            'La extensión del archivo no coincide con el tipo de audio detectado.',
          status: 400,
          retryable: false,
          details: {
            extension: ext,
            detectedFormat: detected.ext,
            detectedMime: detected.mime,
          },
        });
      }
    }

    return {
      ext,
      mime: detected.mime,
    };
  }

  private detectAudioUpload(bytes: Buffer): DetectedAudioUpload | null {
    if (bytes.length < 4) return null;

    if (
      bytes.length >= 12 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WAVE'
    ) {
      return { ext: 'wav', mime: 'audio/wav' };
    }

    if (bytes.toString('ascii', 0, 4) === 'fLaC') {
      return { ext: 'flac', mime: 'audio/flac' };
    }

    if (this.looksLikeMp4Audio(bytes)) {
      return { ext: 'm4a', mime: 'audio/mp4' };
    }

    if (this.looksLikeAacAdts(bytes)) {
      return { ext: 'aac', mime: 'audio/aac' };
    }

    if (bytes.toString('ascii', 0, 3) === 'ID3' || this.looksLikeMp3Frame(bytes)) {
      return { ext: 'mp3', mime: 'audio/mpeg' };
    }

    return null;
  }

  private looksLikeMp3Frame(bytes: Buffer): boolean {
    if (bytes.length < 2) return false;
    return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  }

  private looksLikeMp4Audio(bytes: Buffer): boolean {
    if (bytes.length < 12) return false;
    const box = bytes.toString('ascii', 4, 8);
    if (box !== 'ftyp') return false;

    const brandWindow = bytes.toString(
      'ascii',
      8,
      Math.min(bytes.length, 32)
    );
    return /M4A|mp4|isom|iso2|3gp/i.test(brandWindow);
  }

  private looksLikeAacAdts(bytes: Buffer): boolean {
    if (bytes.length < 2) return false;
    return bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0;
  }

  private extensionFromName(
    name: string | undefined,
    mode: 'audio' | 'voice',
    fallback?: string
  ): string {
    const fallbackExt = fallback ?? (mode === 'voice' ? 'm4a' : 'wav');
    if (!name) return fallbackExt;
    const clean = name.split('?')[0].trim();
    const dot = clean.lastIndexOf('.');
    if (dot < 0 || dot >= clean.length - 1) return fallbackExt;
    const ext = clean.substring(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!ext) return fallbackExt;
    if (ext.length > 8) return fallbackExt;
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

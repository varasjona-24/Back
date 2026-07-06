import type { ErrorRequestHandler, Request, Response } from 'express';

export type ApiErrorCode =
  | 'UNKNOWN_ERROR'
  | 'VALIDATION_ERROR'
  | 'MEDIA_INVALID_URL'
  | 'MEDIA_UNSUPPORTED_SOURCE'
  | 'MEDIA_COOKIES_REQUIRED'
  | 'MEDIA_PROTECTED_CONTENT'
  | 'MEDIA_DOWNLOAD_FAILED'
  | 'MEDIA_DOWNLOAD_TIMEOUT'
  | 'MEDIA_FORMAT_UNAVAILABLE'
  | 'MEDIA_VARIANT_EXPIRED'
  | 'MEDIA_FILE_NOT_FOUND'
  | 'KARAOKE_BACKEND_BUSY'
  | 'KARAOKE_UPLOAD_TOO_LARGE'
  | 'KARAOKE_UNSUPPORTED_AUDIO_FORMAT'
  | 'KARAOKE_INVALID_AUDIO_BYTES'
  | 'KARAOKE_AUDIO_EXTENSION_MISMATCH'
  | 'KARAOKE_PROCESS_TIMEOUT'
  | 'KARAOKE_PROCESS_FAILED'
  | 'KARAOKE_OUTPUT_NOT_READY'
  | 'KARAOKE_SESSION_EXPIRED'
  | 'KARAOKE_OUTPUT_EXPIRED';

export type ApiErrorOptions = {
  code: ApiErrorCode;
  message: string;
  userMessage?: string;
  status?: number;
  retryable?: boolean;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly userMessage: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: Record<string, unknown>;

  constructor(options: ApiErrorOptions) {
    super(options.message);
    this.name = 'ApiError';
    this.code = options.code;
    this.userMessage = options.userMessage ?? options.message;
    this.status = options.status ?? 400;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
  }
}

export function apiError(options: ApiErrorOptions): ApiError {
  return new ApiError(options);
}

export function apiErrorBody(error: ApiError) {
  return {
    error: error.userMessage,
    code: error.code,
    message: error.message,
    userMessage: error.userMessage,
    retryable: error.retryable,
    retryAfterSeconds: error.retryAfterSeconds ?? null,
    details: error.details ?? null,
  };
}

export function sendApiError(res: Response, error: ApiError): Response {
  if (error.retryAfterSeconds != null) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
  return res.status(error.status).json(apiErrorBody(error));
}

export function normalizeApiError(error: unknown, fallback: ApiErrorOptions): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    return new ApiError({
      ...fallback,
      message: error.message || fallback.message,
      userMessage: fallback.userMessage ?? error.message ?? fallback.message,
    });
  }
  return new ApiError(fallback);
}

function isPayloadTooLarge(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const map = error as Record<string, unknown>;
  return map.type === 'entity.too.large' || map.status === 413 || map.statusCode === 413;
}

function isKaraokeUpload(req: Request): boolean {
  return req.method === 'POST' && req.path.endsWith('/karaoke/sessions');
}

export const apiErrorMiddleware: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (isPayloadTooLarge(error) && isKaraokeUpload(req)) {
    sendApiError(
      res,
      apiError({
        code: 'KARAOKE_UPLOAD_TOO_LARGE',
        message: 'Karaoke upload exceeded body limit.',
        userMessage: 'El audio es demasiado grande para procesarlo en el backend.',
        status: 413,
        retryable: false,
        details: {
          limit: process.env.KARAOKE_UPLOAD_LIMIT?.trim() || '120mb',
        },
      })
    );
    return;
  }

  if (error instanceof ApiError) {
    sendApiError(res, error);
    return;
  }

  sendApiError(
    res,
    normalizeApiError(error, {
      code: 'UNKNOWN_ERROR',
      message: 'Unexpected server error.',
      userMessage: 'Ocurrió un error inesperado en el backend.',
      status: 500,
      retryable: true,
    })
  );
};

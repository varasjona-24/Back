export type MediaVariant = {
  kind: 'audio' | 'video';
  format: 'mp3' | 'm4a' | 'mp4';
  path: string;        // ✅ NUEVO
  createdAt: number;
  /** Epoch ms. If set, file should be considered expired after this time. */
  expiresAt?: number;
};

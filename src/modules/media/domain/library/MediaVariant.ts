export type MediaVariant = {
  kind: 'audio' | 'video';
  format: 'mp3' | 'm4a' | 'mp4';
  path: string;        // ✅ NUEVO
  createdAt: number;
};

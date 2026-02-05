import { spawn } from 'child_process';
import { getYtDlpExtraArgs, getYtDlpPath } from '../ytDlp.js';

export interface YoutubeResolvedInfo {
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
}

export class YoutubeInfoSource {

  async resolve(url: string): Promise<YoutubeResolvedInfo> {
    const ytDlpPath = await getYtDlpPath();
    const extraArgs = await getYtDlpExtraArgs();

    return new Promise((resolve, reject) => {
      const child = spawn(ytDlpPath, [
        ...extraArgs,
        '--dump-json',
        '--no-playlist',
        url
      ]);

      let data = '';
      let stderr = '';

      child.stdout.on('data', chunk => {
        data += chunk.toString();
      });

      child.stderr?.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('close', code => {
        try {
          if (code !== 0) {
            const detail = stderr.trim();
            return reject(
              new Error(
                detail
                  ? `yt-dlp failed to resolve info: ${detail}`
                  : 'yt-dlp failed to resolve info'
              )
            );
          }

          if (!data.trim()) {
            return reject(new Error('yt-dlp returned empty info'));
          }

          const json = JSON.parse(data);

          resolve({
            title: json.title,
            artist: json.uploader ?? 'Unknown',
            duration: json.duration * 1000,
            thumbnail: json.thumbnail ?? null
          });
        } catch (err) {
          reject(err);
        }
      });

      child.on('error', reject);
    });
  }
}

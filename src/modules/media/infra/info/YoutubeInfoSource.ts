import { spawn } from 'child_process';

export interface YoutubeResolvedInfo {
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
}

export class YoutubeInfoSource {

  resolve(url: string): Promise<YoutubeResolvedInfo> {
    return new Promise((resolve, reject) => {

      const child = spawn('yt-dlp', [
        '--dump-json',
        '--no-playlist',
        url
      ]);

      let data = '';

      child.stdout.on('data', chunk => {
        data += chunk.toString();
      });

      child.on('close', () => {
        try {
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

import { Readable } from 'stream';
import type { ResolveMedia as ResolveMediaType } from '../modules/media/domain/usecases/Resolve_Media.js';
import { ResolvedAudio } from '../modules/media/domain/usecases/types.js';

class DummySource {
  canHandle(url: string): boolean {
    return url === 'http://example.com/audio';
  }

  async getAudioStream(url: string, startByte = 0): Promise<ResolvedAudio> {
    const stream = Readable.from(['hello']);
    return { stream, mimeType: 'audio/test', contentLength: 5 };
  }
}

async function run() {
  const mod = await import('../modules/media/domain/usecases/Resolve_Media.js').catch(() => null);
  if (!mod || !mod.ResolveMedia) {
    throw new Error('Failed to load ResolveMedia implementation from compiled output');
  }
  const ResolveMedia = mod.ResolveMedia as unknown as {
    new (sources: any[]): ResolveMediaType
  };

  const resolver = new ResolveMedia([new DummySource() as any]);
const audio = await resolver.execute(
  'http://example.com/audio',
  'bytes=0-'
);
  console.log('stream mime:', audio.mimeType);
  audio.stream.on('data', (chunk: Buffer | string) => {
    console.log('data:', chunk.toString());
  });
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

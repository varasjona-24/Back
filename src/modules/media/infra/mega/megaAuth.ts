import { Storage } from 'megajs';

type MegaApiLike = object;

type MegaStorageLike = {
  api: MegaApiLike;
  ready: Promise<unknown>;
};

let storagePromise: Promise<MegaStorageLike | null> | null = null;

function hasCredentials(): boolean {
  return Boolean(process.env.MEGA_EMAIL?.trim() && process.env.MEGA_PASSWORD?.trim());
}

async function createStorage(): Promise<MegaStorageLike | null> {
  if (!hasCredentials()) return null;

  const storage = new Storage({
    email: process.env.MEGA_EMAIL!.trim(),
    password: process.env.MEGA_PASSWORD!.trim(),
    secondFactorCode: process.env.MEGA_2FA_CODE?.trim() || undefined,
    keepalive: true,
    autoload: false,
    autologin: true,
  }) as unknown as MegaStorageLike;

  await storage.ready;
  return storage;
}

export async function getMegaApi(): Promise<MegaApiLike | undefined> {
  if (!storagePromise) {
    storagePromise = createStorage();
  }

  try {
    const storage = await storagePromise;
    return storage?.api;
  } catch (error) {
    storagePromise = null;

    if (hasCredentials()) {
      throw new Error(`MEGA auth failed: ${(error as Error)?.message ?? String(error)}`);
    }

    return undefined;
  }
}

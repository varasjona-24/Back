import fs from 'fs';
import path from 'path';

import { detectSourceOrigin } from '../modules/media/domain/usecases/Detect_Source_Origin.js';
import type { NormalizedMediaInfo } from '../modules/media/domain/usecases/types.js';

type MediaRecord = NormalizedMediaInfo & { variants?: unknown[] };

const filePath = path.resolve(process.cwd(), 'data/media-library.json');

const safeDecodeUrl = (sourceId?: string): string | null => {
  if (!sourceId || sourceId.trim().length === 0) return null;

  try {
    const decoded = Buffer.from(sourceId, 'base64').toString('utf-8').trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
};

const main = () => {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) {
    console.log('media-library.json is empty, nothing to migrate.');
    return;
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('media-library.json must contain an array');
  }

  const items: MediaRecord[] = parsed;
  let updated = 0;

  for (const item of items) {
    if (item.source !== 'generic') continue;

    const url = safeDecodeUrl(item.sourceId);
    if (!url) continue;

    const detected = detectSourceOrigin(url);
    if (detected === 'generic') continue;

    item.source = detected;
    updated++;
  }

  fs.writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf-8');
  console.log(`Updated ${updated} media items.`);
};

main();

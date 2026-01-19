import path from 'path';
import { JsonMediaLibrary } from './JsonMediaLibrary.js';

const filePath = path.resolve(
  process.cwd(),
  'data/media-library.json'
);

export const mediaLibrary = new JsonMediaLibrary(filePath);

import path from 'path';
import { JsonPlaylistRepository } from './json/JsonPlaylistRepository.js';

const filePath = path.resolve(
  process.cwd(),
  'data/playlists.json'
);

export const playlistRepository = new JsonPlaylistRepository(filePath);

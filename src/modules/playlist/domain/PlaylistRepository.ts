import { Playlist } from './Playlist.js';

export interface PlaylistRepository {
  create(name: string): Playlist;
  list(): Playlist[];
  getById(id: string): Playlist | undefined;
  addMedia(playlistId: string, mediaId: string): Playlist;
  updateName(id: string, name: string): Playlist;
removeMedia(playlistId: string, mediaId: string): Playlist;
delete(id: string): void;

}

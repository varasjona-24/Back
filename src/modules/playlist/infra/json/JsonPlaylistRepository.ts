import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { Playlist } from '../../domain/Playlist.js';
import { PlaylistRepository } from '../../domain/PlaylistRepository.js';

export class JsonPlaylistRepository implements PlaylistRepository {
  private items = new Map<string, Playlist>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load() {
    const dir = path.dirname(this.filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '[]', 'utf-8');
    }

    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const list: Playlist[] = JSON.parse(raw);

    for (const playlist of list) {
      this.items.set(playlist.id, playlist);
    }
  }

  private save() {
    const list = Array.from(this.items.values());
    fs.writeFileSync(
      this.filePath,
      JSON.stringify(list, null, 2),
      'utf-8'
    );
  }

  create(name: string): Playlist {
    const playlist: Playlist = {
      id: randomUUID(),
      name,
      mediaIds: [],
      createdAt: Date.now()
    };

    this.items.set(playlist.id, playlist);
    this.save();
    return playlist;
  }
  removeMedia(playlistId: string, mediaId: string): Playlist {
  const playlist = this.items.get(playlistId);

  if (!playlist) {
    throw new Error('Playlist not found');
  }

  playlist.mediaIds = playlist.mediaIds.filter(id => id !== mediaId);
  this.save();
  return playlist;
}
delete(id: string): void {
  if (!this.items.has(id)) {
    throw new Error('Playlist not found');
  }

  this.items.delete(id);
  this.save();
}


  list(): Playlist[] {
    return Array.from(this.items.values());
  }

  getById(id: string): Playlist | undefined {
    return this.items.get(id);
  }

  addMedia(playlistId: string, mediaId: string): Playlist {
    const playlist = this.items.get(playlistId);

    if (!playlist) {
      throw new Error('Playlist not found');
    }

    if (!playlist.mediaIds.includes(mediaId)) {
      playlist.mediaIds.push(mediaId);
      this.save();
    }

    return playlist;
  }
  updateName(id: string, name: string): Playlist {
  const playlist = this.items.get(id);

  if (!playlist) {
    throw new Error('Playlist not found');
  }

  playlist.name = name;
  this.save();
  return playlist;
}

}
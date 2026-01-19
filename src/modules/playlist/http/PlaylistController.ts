import { Request, Response } from 'express';
import { playlistRepository } from '../infra/index.js';

export class PlaylistController {
  create(req: Request, res: Response) {
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        error: 'Field "name" is required'
      });
    }

    const playlist = playlistRepository.create(name);
    res.status(201).json(playlist);
  }

  list(_req: Request, res: Response) {
    res.json(playlistRepository.list());
  }

  getById(req: Request, res: Response) {
    const { id } = req.params;
    const playlist = playlistRepository.getById(id);

    if (!playlist) {
      return res.status(404).json({
        error: 'Playlist not found'
      });
    }

    res.json(playlist);
  }
  update(req: Request, res: Response) {
  const { id } = req.params;
  const { name } = req.body;

  if (!name || typeof name !== 'string') {
    return res.status(400).json({
      error: 'Field "name" is required'
    });
  }

  

  try {
    const playlist = playlistRepository.updateName(id, name);
    res.json(playlist);
  } catch {
    res.status(404).json({
      error: 'Playlist not found'
    });
  }
}
removeMedia(req: Request, res: Response) {
  const { id } = req.params;
  const { mediaId } = req.body;

  if (!mediaId || typeof mediaId !== 'string') {
    return res.status(400).json({ error: 'Field "mediaId" is required' });
  }

  try {
    res.json(playlistRepository.removeMedia(id, mediaId));
  } catch {
    res.status(404).json({ error: 'Playlist not found' });
  }
}
delete(req: Request, res: Response) {
  const { id } = req.params;

  try {
    playlistRepository.delete(id);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Playlist not found' });
  }
}



  addMedia(req: Request, res: Response) {
    const { id } = req.params;
    const { mediaId } = req.body;

    if (!mediaId || typeof mediaId !== 'string') {
      return res.status(400).json({
        error: 'Field "mediaId" is required'
      });
    }

    try {
      const playlist = playlistRepository.addMedia(id, mediaId);
      res.json(playlist);
    } catch (error) {
      res.status(404).json({
        error: 'Playlist not found'
      });
    }
  }
}

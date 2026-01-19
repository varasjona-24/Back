import { Router } from 'express';
import { MediaController } from './MediaController.js';

const router = Router();
const controller = new MediaController();

// 🔊 Streaming de audio
router.get('/stream', (req, res) =>
  controller.stream(req, res)
);

// ℹ️ Resolver metadata
router.get('/resolve-info', (req, res) =>
  controller.resolveInfo(req, res)
);

// 📚 Biblioteca
router.get('/library', (req, res) =>
  controller.library(req, res)
);

// 🎤 Biblioteca por artista
router.get('/library/artists', (req, res) =>
  controller.libraryBYArtist(req, res)
);

// ⬇️ Descargar media
router.post('/download', (req, res) =>
  controller.download(req, res)
);

// 📁 SERVIR ARCHIVO (ESTE ES EL QUE FALTABA)
router.get('/file/:mediaId/:kind/:format', (req, res) =>
  controller.file(req, res)
);

export default router;

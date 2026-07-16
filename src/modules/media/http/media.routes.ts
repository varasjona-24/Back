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

// 🎧 Biblioteca agrupada por artista
router.get('/library/artists/grouped', (req, res) =>
  controller.libraryByArtist(req, res)
);

// ⬇️ Descargar media
router.post('/download', (req, res) =>
  controller.download(req, res)
);

// 🎼 Importar playlist externa como playlist interna
router.post('/playlist/import', (req, res) =>
  controller.importPlaylist(req, res)
);

// 📁 SERVIR ARCHIVO (ESTE ES EL QUE FALTABA)
router.get('/file/:mediaId/:kind/:format', (req, res) =>
  controller.file(req, res)
);

// 🔐 ADMIN: actualizar cookies de yt-dlp
router.post('/admin/ytdlp-cookies', (req, res) =>
  controller.updateYtDlpCookies(req, res)
);

export default router;

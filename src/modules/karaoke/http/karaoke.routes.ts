import express from 'express';
import { Router } from 'express';
import { KaraokeController } from './KaraokeController.js';

const router = Router();
const controller = new KaraokeController();

function karaokeUploadLimit(): string {
  const raw = process.env.KARAOKE_UPLOAD_LIMIT?.trim();
  if (raw && /^\d+(\.\d+)?\s*(b|kb|mb|gb)$/i.test(raw)) {
    return raw;
  }
  return '120mb';
}

router.get('/health', (req, res) => controller.health(req, res));

router.post(
  '/sessions',
  express.raw({ type: '*/*', limit: karaokeUploadLimit() }),
  (req, res) => controller.createSession(req, res)
);
router.get('/sessions/:sessionId', (req, res) => controller.getSession(req, res));
router.get('/sessions/:sessionId/instrumental', (req, res) =>
  controller.sessionInstrumental(req, res)
);
router.get('/sessions/:sessionId/spatial8d', (req, res) =>
  controller.sessionSpatial8d(req, res)
);

router.post('/jobs', (req, res) => controller.createJob(req, res));
router.get('/jobs/:jobId', (req, res) => controller.getJob(req, res));
router.get('/jobs/:jobId/instrumental', (req, res) =>
  controller.instrumental(req, res)
);

export default router;

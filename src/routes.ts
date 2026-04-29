import { Router } from 'express';
import mediaRoutes from './modules/media/http/media.routes.js';
import schemaRoutes from './modules/schema/http/schema.routes.js';
import playlistRoutes from './modules/playlist/http/playlists.routes.js';
import karaokeRoutes from './modules/karaoke/http/karaoke.routes.js';
import agentRoutes from './modules/agent/http/agent.routes.js';
import { AgentController } from './modules/agent/http/AgentController.js';

const router = Router();
const agentController = new AgentController();


router.use('/api/v1/media', mediaRoutes);

// ✅ MEDIA PRIMERO
router.use('/media', mediaRoutes);
// ✅ PLAYLISTS DESPUÉS
router.use('/playlists', playlistRoutes);
// ✅ KARAOKE JOBS
router.use('/karaoke', karaokeRoutes);
// ✅ AGENTE: Atlas + recomendaciones remotas
router.use('/agent', agentRoutes);
router.get('/countries', (req, res) => agentController.countries(req, res));

// ✅ SCHEMA SOLO EN SU PATH
router.use('/schema', schemaRoutes);

export default router;

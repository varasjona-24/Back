import { Router } from 'express';
import mediaRoutes from './modules/media/http/media.routes.js';
import schemaRoutes from './modules/schema/http/schema.routes.js';
import playlistRoutes from './modules/playlist/http/playlists.routes.js';

const router = Router();


router.use('/api/v1/media', mediaRoutes);

// ✅ MEDIA PRIMERO
router.use('/media', mediaRoutes);
// ✅ PLAYLISTS DESPUÉS
router.use('/playlists', playlistRoutes);

// ✅ SCHEMA SOLO EN SU PATH
router.use('/schema', schemaRoutes);

export default router;


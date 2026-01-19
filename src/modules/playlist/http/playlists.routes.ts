import { Router } from 'express';
import { PlaylistController } from './PlaylistController.js';

const router = Router();
const controller = new PlaylistController();

router.post('/', (req, res) => controller.create(req, res));
router.get('/', (req, res) => controller.list(req, res));
router.get('/:id', (req, res) => controller.getById(req, res));
router.post('/:id/add', (req, res) => controller.addMedia(req, res));
    router.patch('/:id', (req, res) =>
    controller.update(req, res)
    );
router.post('/:id/remove', (req, res) => controller.removeMedia(req, res));
router.delete('/:id', (req, res) => controller.delete(req, res));


export default router
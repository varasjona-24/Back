// schema.routes.ts
import { Router } from 'express';
import { SchemaController } from './SchemaController.js';

const router = Router();
const controller = new SchemaController();

router.get('/current', controller.current);
router.get('/sql', controller.sql);

export default router;

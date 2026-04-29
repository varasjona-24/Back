import { Router } from 'express';
import { AgentController } from './AgentController.js';

const router = Router();
const controller = new AgentController();

router.get('/health', (req, res) => controller.health(req, res));
router.get('/countries', (req, res) => controller.countries(req, res));
router.post('/explore-country', (req, res) => controller.exploreCountry(req, res));
router.post('/continue-station', (req, res) => controller.continueStation(req, res));
router.post('/recommendations/daily', (req, res) => controller.dailyRecommendations(req, res));

export default router;

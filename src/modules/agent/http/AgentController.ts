import type { Request, Response } from 'express';
import { AgentRecommendationService } from '../domain/AgentRecommendationService.js';

export class AgentController {
  private readonly service = new AgentRecommendationService();

  health(_req: Request, res: Response) {
    return res.json({ ok: true, module: 'agent' });
  }

  countries(_req: Request, res: Response) {
    return res.json({ data: this.service.countries() });
  }

  exploreCountry(req: Request, res: Response) {
    return res.json({ data: this.service.exploreCountry(this.body(req)) });
  }

  continueStation(req: Request, res: Response) {
    return res.json({ data: this.service.continueStation(this.body(req)) });
  }

  dailyRecommendations(req: Request, res: Response) {
    return res.json({ data: this.service.dailyRecommendations(this.body(req)) });
  }

  private body(req: Request): Record<string, unknown> {
    return req.body && typeof req.body === 'object'
      ? req.body as Record<string, unknown>
      : {};
  }
}

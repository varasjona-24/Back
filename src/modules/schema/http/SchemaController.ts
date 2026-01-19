// SchemaController.ts
import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export class SchemaController {

  current(req: Request, res: Response) {
    return res.json({
      version: 1,
      name: 'library'
    });
  }

  sql(req: Request, res: Response) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const schemaPath = path.resolve(
      __dirname,
      '../../../database/schema_v1.sql'
    );

    if (!fs.existsSync(schemaPath)) {
      return res.status(404).json({ error: 'Schema file not found' });
    }

    try {
      const sql = fs.readFileSync(schemaPath, 'utf-8');
      res.type('text/plain').send(sql);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to read schema file' });
    }
  }
}

import express from 'express';
import routes from './routes.js';

const app = express();

app.use('/api/v1/media/stream', (_req, _res, next) => {
  next();
});

app.use(express.json());
app.use('/api/v1', routes);

export default app;

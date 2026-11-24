import express, { Router } from 'express';
import helmet from 'helmet';
import { config } from './config';
import { pool } from './db/pool';
import { asyncHandler } from './lib/http';
import { registry } from './lib/metrics';
import { redis } from './lib/redis';
import { requireAuth } from './middleware/auth';
import { errorHandler, routeNotFound } from './middleware/errorHandler';
import { requestMetrics } from './middleware/requestMetrics';
import { authRouter } from './modules/auth/routes';
import { channelsRouter } from './modules/channels/routes';
import { messagesRouter } from './modules/messages/routes';
import { notificationsRouter } from './modules/notifications/routes';
import { searchRouter } from './modules/search/routes';
import { workspacesRouter } from './modules/workspaces/routes';

export function createApp() {
  const app = express();

  // Behind Nginx: trust one proxy hop so req.ip is the real client, not the proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '64kb' }));

  // Shows which instance answered - handy for watching the load balancer work.
  app.use((_req, res, next) => {
    res.setHeader('X-Instance', config.instance);
    next();
  });
  app.use(requestMetrics);

  // Liveness: "is the process up?" Must not depend on anything else.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: "can this instance serve traffic right now?" Checks its dependencies.
  app.get(
    '/readyz',
    asyncHandler(async (_req, res) => {
      try {
        await Promise.all([pool.query('SELECT 1'), redis.ping()]);
        res.json({ status: 'ready' });
      } catch (err) {
        res.status(503).json({ status: 'not ready', reason: (err as Error).message });
      }
    }),
  );

  app.get(
    '/metrics',
    asyncHandler(async (_req, res) => {
      res.setHeader('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    }),
  );

  const api = Router();
  api.use(authRouter); // signup and login are public; /me checks the token itself
  api.use(requireAuth); // everything below needs a valid token
  api.use(workspacesRouter);
  api.use(channelsRouter);
  api.use(messagesRouter);
  api.use(searchRouter);
  api.use(notificationsRouter);

  app.use('/api', api);
  app.use(routeNotFound);
  app.use(errorHandler);
  return app;
}

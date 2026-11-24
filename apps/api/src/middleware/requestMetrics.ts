import type { RequestHandler } from 'express';
import { httpDuration } from '../lib/metrics';

/**
 * Records how long every request took.
 *
 * The label is the route *template* ("/api/channels/:channelId/messages"),
 * never the real URL: one label value per channel id would create millions of
 * time series and take the metrics system down.
 */
export const requestMetrics: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
    httpDuration.observe({ method: req.method, route, status: String(res.statusCode) }, seconds);
  });
  next();
};

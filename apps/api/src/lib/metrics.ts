import client from 'prom-client';

/** Prometheus metrics, scraped from GET /metrics. */
export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'api' });
client.collectDefaultMetrics({ register: registry });

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration by method, route template and status code',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const messagesSent = new client.Counter({
  name: 'messages_sent_total',
  help: 'Messages accepted by the API (duplicates from retries are not counted)',
  registers: [registry],
});

export const cacheRequests = new client.Counter({
  name: 'cache_requests_total',
  help: 'Cache lookups by cache name and result (hit or miss)',
  labelNames: ['cache', 'result'],
  registers: [registry],
});

export const rateLimited = new client.Counter({
  name: 'rate_limited_total',
  help: 'Requests rejected by the rate limiter',
  labelNames: ['limiter'],
  registers: [registry],
});

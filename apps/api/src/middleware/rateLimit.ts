import type { Request, RequestHandler } from 'express';
import { HttpError } from '../lib/errors';
import { rateLimited } from '../lib/metrics';
import { redis } from '../lib/redis';

/**
 * Fixed-window rate limiter backed by Redis.
 *
 * The counter lives in Redis rather than in process memory because there are
 * several API instances behind the load balancer: a per-process counter would
 * let a client send `limit x instances` requests.
 *
 * INCR and PEXPIRE run inside one Lua script so they are atomic. Without that,
 * a crash between the two commands would leave a counter that never expires.
 *
 * Known weakness of fixed windows: a client can burst up to 2x the limit
 * across a window boundary. A sliding window or token bucket fixes that at
 * the cost of more state; see docs/phases/08-production-readiness.md.
 */
const INCREMENT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export interface RateLimitOptions {
  /** Short name used in the Redis key and in metrics. */
  name: string;
  /** Maximum requests per window. */
  limit: number;
  windowMs: number;
  /** Who is being limited: an IP address before login, a user id after. */
  key: (req: Request) => string;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  return (req, res, next) => {
    const key = `rl:${options.name}:${options.key(req)}`;
    redis
      .eval(INCREMENT, 1, key, String(options.windowMs))
      .then(
        (result) => {
          const count = Number(result);
          res.setHeader('X-RateLimit-Limit', String(options.limit));
          res.setHeader('X-RateLimit-Remaining', String(Math.max(0, options.limit - count)));
          if (count > options.limit) {
            rateLimited.inc({ limiter: options.name });
            res.setHeader('Retry-After', String(Math.ceil(options.windowMs / 1000)));
            next(new HttpError(429, 'rate_limited', 'Too many requests, please slow down'));
            return;
          }
          next();
        },
        // Fail open: if Redis is unavailable we would rather serve traffic
        // unthrottled than reject every request.
        () => next(),
      );
  };
}

export const clientIp = (req: Request): string => req.ip ?? 'unknown';

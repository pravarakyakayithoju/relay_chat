import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { unauthorized } from '../lib/errors';

export interface AuthUser {
  id: string;
  username: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Stateless auth: the token itself carries the user id and is signed with a
 * secret every API and gateway instance knows. No session store, so any
 * instance can serve any request - which is what makes the API horizontally
 * scalable. The trade-off: a token cannot be revoked before it expires.
 */
export function signToken(user: AuthUser): string {
  return jwt.sign({ username: user.username }, config.jwtSecret, {
    subject: user.id,
    expiresIn: config.jwtExpiresInSeconds,
  });
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload === 'string') return null;
    if (typeof payload.sub !== 'string' || typeof payload.username !== 'string') return null;
    return { id: payload.sub, username: payload.username };
  } catch {
    return null;
  }
}

/** Requires `Authorization: Bearer <token>` and puts the user on `req.user`. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const user = token ? verifyToken(token) : null;
  if (!user) {
    next(unauthorized());
    return;
  }
  req.user = user;
  next();
};

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { isMessageId } from '@relay/shared';
import type { AuthUser } from '../middleware/auth';
import { badRequest, unauthorized } from './errors';

/**
 * Express 4 does not catch rejected promises from async handlers, so an
 * unhandled error would hang the request. This forwards them to the error handler.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** The authenticated user. Routes behind `requireAuth` always have one. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

const uuid = z.string().uuid();

/** Validate a UUID path parameter so bad input is a 400, not a database error. */
export function uuidParam(req: Request, name: string): string {
  const parsed = uuid.safeParse(req.params[name]);
  if (!parsed.success) throw badRequest(`${name} must be a UUID`);
  return parsed.data;
}

/** Zod schema for a message id passed as a string. */
export const messageIdSchema = z.string().refine(isMessageId, 'must be a message id');

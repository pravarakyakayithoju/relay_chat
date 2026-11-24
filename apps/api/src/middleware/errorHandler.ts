import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@relay/shared';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';

export const routeNotFound: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, 'not_found', 'Route not found'));
};

/**
 * Every error leaves the API in the same shape: { error: { code, message } }.
 * Unexpected errors are logged with their stack but never leaked to the client.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const send = (status: number, code: string, message: string) => {
    const body: ApiErrorBody = { error: { code, message } };
    res.status(status).json(body);
  };

  if (err instanceof ZodError) {
    const message = err.issues
      .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
    send(400, 'validation_error', message);
    return;
  }
  if (err instanceof HttpError) {
    send(err.status, err.code, err.message);
    return;
  }
  // Malformed or oversized JSON bodies rejected by express.json().
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') {
    send(400, 'bad_request', 'Request body is not valid JSON');
    return;
  }
  if (type === 'entity.too.large') {
    send(413, 'too_large', 'Request body is too large');
    return;
  }

  logger.error({ err, method: req.method, path: req.path }, 'unhandled error');
  send(500, 'internal', 'Internal server error');
};

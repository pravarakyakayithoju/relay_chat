/** An error that maps to a specific HTTP response. Anything else becomes a 500. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const unauthorized = (message = 'Missing or invalid token') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message: string) => new HttpError(403, 'forbidden', message);
export const notFound = (message: string) => new HttpError(404, 'not_found', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

/** Postgres error codes we handle on purpose. */
export function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}
export const isUniqueViolation = (err: unknown) => pgErrorCode(err) === '23505';

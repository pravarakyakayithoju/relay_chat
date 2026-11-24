import pino from 'pino';
import { config } from '../config';

/** Structured JSON logs: one line per event, easy to search and to ship to a log store. */
export const logger = pino({
  level: config.logLevel,
  base: { service: 'api', instance: config.instance },
});

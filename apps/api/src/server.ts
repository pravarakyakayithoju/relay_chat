import { createApp } from './app';
import { config } from './config';
import { closePools } from './db/pool';
import { logger } from './lib/logger';
import { redis } from './lib/redis';

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, nodeId: config.nodeId }, 'api listening');
});

/**
 * Graceful shutdown. On a deploy or scale-down the orchestrator sends SIGTERM:
 * stop accepting new connections, let in-flight requests finish, then close
 * the database and Redis connections. Killing the process outright would drop
 * requests that were halfway through.
 */
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  // Safety net: never hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();

  server.close(() => {
    Promise.allSettled([closePools(), redis.quit()]).then(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

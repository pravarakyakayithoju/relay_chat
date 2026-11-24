import http from 'node:http';
import type { Consumer } from 'kafkajs';
import { config } from './config';
import { runWorker } from './consumer';
import { handleLinkPreview } from './handlers/linkPreview';
import { handleNotifications } from './handlers/notifications';
import { handleSearchIndex } from './handlers/searchIndexer';
import { ensureTopics, logger, pool, producer, redis, registry } from './lib';
import { startOutboxRelay } from './outboxRelay';

async function main(): Promise<void> {
  const metricsServer = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (req.url === '/metrics') {
      registry
        .metrics()
        .then((body) => res.writeHead(200, { 'Content-Type': registry.contentType }).end(body))
        .catch(() => res.writeHead(500).end());
      return;
    }
    res.writeHead(404).end();
  });
  metricsServer.listen(config.metricsPort);

  await ensureTopics();
  await producer.connect();

  const consumers: Consumer[] = [];
  let relay: { stop: () => Promise<void> } | null = null;

  if (config.workers.includes('outbox')) relay = startOutboxRelay();
  if (config.workers.includes('notifications')) {
    consumers.push(await runWorker({ name: 'notifications', handle: handleNotifications }));
  }
  if (config.workers.includes('search')) {
    consumers.push(await runWorker({ name: 'search', handle: handleSearchIndex }));
  }
  if (config.workers.includes('previews')) {
    consumers.push(await runWorker({ name: 'previews', handle: handleLinkPreview }));
  }
  logger.info({ workers: config.workers, metricsPort: config.metricsPort }, 'workers running');

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), 15_000).unref();

    (async () => {
      // Stop taking new work first, let in-flight handlers finish, then close connections.
      await relay?.stop();
      await Promise.allSettled(consumers.map((consumer) => consumer.disconnect()));
      await Promise.allSettled([producer.disconnect(), pool.end(), redis.quit()]);
      metricsServer.close();
      process.exit(0);
    })().catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, 'workers failed to start');
  process.exit(1);
});

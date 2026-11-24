import type { Consumer } from 'kafkajs';
import { KAFKA_TOPICS, type MessageCreatedEvent } from '@relay/shared';
import { config } from './config';
import { eventsProcessed, kafka, logger, producer, sleep } from './lib';

export interface WorkerDefinition {
  /** Used in logs, metrics and as the consumer group id. */
  name: string;
  handle: (event: MessageCreatedEvent) => Promise<void>;
}

/**
 * Runs one worker as its own Kafka consumer group.
 *
 * Consumer groups are what make one event stream feed several independent
 * jobs: every group gets every event and tracks its own position, so a slow
 * link-preview worker never delays notifications.
 *
 * Failure handling, in order:
 *   1. Retry the handler a few times with exponential backoff (transient
 *      errors: a database blip, a network timeout).
 *   2. Still failing? Park the event on a dead-letter topic and move on.
 *      One bad event must not block everything queued behind it on the same
 *      partition (a "poison pill").
 */
export async function runWorker(definition: WorkerDefinition): Promise<Consumer> {
  const consumer = kafka.consumer({ groupId: `relay-${definition.name}` });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPICS.messageEvents, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ message, partition }) => {
      const raw = message.value?.toString() ?? '';
      let event: MessageCreatedEvent;
      try {
        event = JSON.parse(raw) as MessageCreatedEvent;
        if (event.type !== 'message.created' || !event.message?.id) throw new Error('unexpected shape');
      } catch {
        eventsProcessed.inc({ worker: definition.name, result: 'invalid' });
        logger.warn({ worker: definition.name, partition, offset: message.offset }, 'skipping invalid event');
        return;
      }

      for (let attempt = 1; ; attempt++) {
        try {
          await definition.handle(event);
          eventsProcessed.inc({ worker: definition.name, result: 'ok' });
          return;
        } catch (err) {
          const error = (err as Error).message;
          if (attempt >= config.maxHandlerAttempts) {
            logger.error(
              { worker: definition.name, eventId: event.eventId, error },
              'handler failed, sending to dead-letter topic',
            );
            await producer.send({
              topic: KAFKA_TOPICS.deadLetter,
              messages: [
                {
                  key: message.key,
                  value: raw,
                  headers: { worker: definition.name, error: error.slice(0, 500) },
                },
              ],
            });
            eventsProcessed.inc({ worker: definition.name, result: 'dead_letter' });
            return;
          }
          eventsProcessed.inc({ worker: definition.name, result: 'retried' });
          await sleep(200 * 2 ** attempt);
        }
      }
    },
  });

  logger.info({ worker: definition.name }, 'worker started');
  return consumer;
}

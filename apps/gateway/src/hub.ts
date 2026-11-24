import { WebSocket } from 'ws';
import type { ServerEvent } from '@relay/shared';
import { config } from './config';
import {
  eventsDelivered,
  loadTopics,
  logger,
  slowConsumersDropped,
  subscribedTopics,
  subscriber,
} from './lib';

/** One WebSocket connection. A user with two browser tabs has two of these. */
export interface Conn {
  id: string;
  ws: WebSocket;
  userId: string | null;
  username: string | null;
  /** Topics this connection receives. */
  topics: Set<string>;
  /** Cleared before each ping, set again by the pong. Still false at the next ping = dead. */
  isAlive: boolean;
  lastTypingAt: number;
}

/**
 * The routing table: topic -> local connections that want it.
 *
 * This gateway subscribes to a Redis topic only while at least one local
 * connection is attached to it, so each instance receives only the traffic it
 * can actually deliver. Ten gateways do not each process every message.
 */
const topicConns = new Map<string, Set<Conn>>();

export function attach(conn: Conn, topic: string): void {
  if (conn.topics.has(topic)) return;
  conn.topics.add(topic);
  let conns = topicConns.get(topic);
  if (!conns) {
    conns = new Set();
    topicConns.set(topic, conns);
    subscribedTopics.set(topicConns.size);
    // Sent on the same Redis connection in the same order as the map changes,
    // so a quick unsubscribe-then-subscribe always ends up subscribed.
    subscriber.subscribe(topic).catch((err: Error) => {
      logger.error({ err: err.message, topic }, 'redis subscribe failed');
    });
  }
  conns.add(conn);
}

export function detach(conn: Conn, topic: string): void {
  if (!conn.topics.delete(topic)) return;
  const conns = topicConns.get(topic);
  if (!conns) return;
  conns.delete(conn);
  if (conns.size === 0) {
    topicConns.delete(topic);
    subscribedTopics.set(topicConns.size);
    subscriber.unsubscribe(topic).catch((err: Error) => {
      logger.error({ err: err.message, topic }, 'redis unsubscribe failed');
    });
  }
}

export function detachAll(conn: Conn): void {
  for (const topic of [...conn.topics]) detach(conn, topic);
}

/** Make the connection's topics exactly `wanted`. */
export function syncTopics(conn: Conn, wanted: Set<string>): void {
  for (const topic of [...conn.topics]) {
    if (!wanted.has(topic)) detach(conn, topic);
  }
  for (const topic of wanted) attach(conn, topic);
}

/** Re-read a user's memberships from Postgres after they joined or left something. */
export async function refreshTopics(conn: Conn): Promise<void> {
  if (!conn.userId) return;
  const wanted = await loadTopics(conn.userId);
  if (conn.ws.readyState === WebSocket.OPEN) syncTopics(conn, wanted);
}

/**
 * Write to one socket, with backpressure protection.
 *
 * `ws.send` never blocks: if the client reads slower than we write, the data
 * queues up in this process's memory. One stalled phone on a bad connection
 * could otherwise grow a buffer without limit. Past the threshold we drop the
 * connection; the client reconnects and reloads history.
 */
export function send(conn: Conn, data: string): void {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  if (conn.ws.bufferedAmount > config.maxBufferedBytes) {
    slowConsumersDropped.inc();
    logger.warn({ connId: conn.id, userId: conn.userId }, 'dropping slow consumer');
    conn.ws.terminate();
    return;
  }
  conn.ws.send(data);
  eventsDelivered.inc();
}

export function sendEvent(conn: Conn, event: ServerEvent): void {
  send(conn, JSON.stringify(event));
}

/**
 * Fan-out: one message from Redis becomes one write per interested local socket.
 * The JSON is parsed once to look at its type, and the original string is
 * forwarded as-is - never re-serialised per connection.
 */
subscriber.on('message', (topic: string, raw: string) => {
  const conns = topicConns.get(topic);
  if (!conns || conns.size === 0) return;

  let event: ServerEvent;
  try {
    event = JSON.parse(raw) as ServerEvent;
  } catch {
    logger.warn({ topic }, 'ignoring malformed event');
    return;
  }

  if (event.type === 'membership.changed') {
    for (const conn of conns) {
      refreshTopics(conn).catch((err: Error) => {
        logger.error({ err: err.message, userId: conn.userId }, 'refreshing topics failed');
      });
    }
  }

  // The person typing does not need to be told that they are typing.
  const skipUserId = event.type === 'typing' ? event.userId : null;
  for (const conn of conns) {
    if (skipUserId !== null && conn.userId === skipUserId) continue;
    send(conn, raw);
  }
});

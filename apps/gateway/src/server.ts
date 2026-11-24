import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { type ClientEvent, type ServerEvent, topics } from '@relay/shared';
import { config } from './config';
import { type Conn, attach, detachAll, sendEvent, syncTopics } from './hub';
import { connectionsGauge, loadTopics, logger, pool, redis, registry, subscriber, verifyToken } from './lib';
import * as presence from './presence';

const TYPING_MIN_INTERVAL_MS = 1500;
/** Custom close code (4000-4999 are free for applications): authentication failed. */
const CLOSE_UNAUTHORIZED = 4401;

const server = http.createServer((req, res) => {
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

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: config.maxPayloadBytes });
const conns = new Set<Conn>();

const workspaceTopicsOf = (conn: Conn) => [...conn.topics].filter((t) => t.startsWith('workspace:'));

wss.on('connection', (ws: WebSocket) => {
  const conn: Conn = {
    id: randomUUID(),
    ws,
    userId: null,
    username: null,
    topics: new Set(),
    isAlive: true,
    lastTypingAt: 0,
  };
  conns.add(conn);
  connectionsGauge.set(conns.size);

  // The client proves who it is in its first message, not in the URL: query
  // strings end up in proxy and server access logs, and a token should not.
  const authTimer = setTimeout(() => {
    if (!conn.userId) ws.close(CLOSE_UNAUTHORIZED, 'authentication timeout');
  }, config.authTimeoutMs);

  ws.on('pong', () => {
    conn.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    handleMessage(conn, data.toString()).catch((err: Error) => {
      logger.error({ err: err.message, connId: conn.id }, 'error handling client message');
    });
  });

  ws.on('error', (err: Error) => {
    logger.debug({ err: err.message, connId: conn.id }, 'socket error');
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    conns.delete(conn);
    connectionsGauge.set(conns.size);
    const workspaceTopics = workspaceTopicsOf(conn);
    detachAll(conn);
    if (conn.userId) void presence.disconnected(conn.userId, conn.id, workspaceTopics);
  });
});

async function handleMessage(conn: Conn, raw: string): Promise<void> {
  let event: ClientEvent;
  try {
    event = JSON.parse(raw) as ClientEvent;
  } catch {
    sendEvent(conn, { type: 'error', message: 'messages must be JSON' });
    return;
  }

  switch (event.type) {
    case 'auth':
      await authenticate(conn, event.token);
      return;

    case 'ping':
      sendEvent(conn, { type: 'pong' });
      return;

    case 'typing': {
      if (!conn.userId || !conn.username) return;
      const topic = topics.channel(String(event.channelId));
      // The connection is only attached to channels the user belongs to, so
      // this doubles as the permission check - no database query needed.
      if (!conn.topics.has(topic)) return;
      const now = Date.now();
      if (now - conn.lastTypingAt < TYPING_MIN_INTERVAL_MS) return;
      conn.lastTypingAt = now;
      const typing: ServerEvent = {
        type: 'typing',
        channelId: String(event.channelId),
        userId: conn.userId,
        username: conn.username,
      };
      // Through Redis, not straight to local sockets: the other people in the
      // channel may be connected to a different gateway instance.
      await redis.publish(topic, JSON.stringify(typing));
      return;
    }

    default:
      sendEvent(conn, { type: 'error', message: 'unknown message type' });
  }
}

async function authenticate(conn: Conn, token: unknown): Promise<void> {
  if (conn.userId) return; // already authenticated
  const user = typeof token === 'string' ? verifyToken(token) : null;
  if (!user) {
    conn.ws.close(CLOSE_UNAUTHORIZED, 'invalid token');
    return;
  }
  conn.userId = user.id;
  conn.username = user.username;

  const wanted = await loadTopics(user.id);
  // The socket may have closed while we were waiting for the database.
  if (conn.ws.readyState !== WebSocket.OPEN) return;

  syncTopics(conn, wanted);
  attach(conn, topics.user(user.id));
  await presence.connected(user.id, conn.id, workspaceTopicsOf(conn));
  sendEvent(conn, { type: 'ready', userId: user.id });
}

/**
 * Heartbeat. A TCP connection can die without either side being told (laptop
 * lid closed, phone leaves Wi-Fi). Every interval we ping each socket; one
 * that has not answered the previous ping is terminated. The same tick
 * refreshes presence in Redis for everyone still here.
 */
const heartbeatTimer = setInterval(() => {
  const alive: { userId: string; connId: string }[] = [];
  for (const conn of conns) {
    if (!conn.isAlive) {
      conn.ws.terminate();
      continue;
    }
    conn.isAlive = false;
    conn.ws.ping();
    if (conn.userId) alive.push({ userId: conn.userId, connId: conn.id });
  }
  void presence.heartbeat(alive);
}, config.heartbeatIntervalMs);

server.listen(config.port, () => {
  logger.info({ port: config.port }, 'gateway listening');
});

/**
 * Graceful shutdown: tell clients we are going away (code 1001) so they
 * reconnect to another instance, then release our resources.
 */
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, connections: conns.size }, 'shutting down');
  clearInterval(heartbeatTimer);
  setTimeout(() => process.exit(1), 10_000).unref();

  for (const conn of conns) conn.ws.close(1001, 'server shutting down');
  wss.close();
  server.close();
  // Give the close handlers a moment to clear presence before disconnecting from Redis.
  setTimeout(() => {
    Promise.allSettled([redis.quit(), subscriber.quit(), pool.end()]).then(() => process.exit(0));
  }, 1000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

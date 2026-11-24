// WebSocket load test: many users holding a live connection in one channel,
// with a few of them talking. Measures how long a message takes to reach everyone.
//
//   k6 run loadtests/ws.js
//   k6 run -e VUS=1000 -e HOLD_SECONDS=60 loadtests/ws.js
//
// What to look at in the output:
//   ws_delivery_latency   ms from "message stored" to "received by a client"
//   ws_messages_received  total deliveries (senders x listeners = fan-out)
//   ws_connecting         time to establish a connection
import { check } from 'k6';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import ws from 'k6/ws';
import { BASE_URL, WS_URL, authHeaders, createWorkspace, joinAsNewUser, uuid } from './lib.js';

const VUS = Number(__ENV.VUS || 200);
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || 45);
/** One in this many users sends messages; the rest only listen. */
const SENDER_RATIO = Number(__ENV.SENDER_RATIO || 20);
const SEND_EVERY_MS = 5000;

const deliveryLatency = new Trend('ws_delivery_latency', true);
const messagesReceived = new Counter('ws_messages_received');

export const options = {
  scenarios: {
    listeners: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: `${HOLD_SECONDS + 120}s`,
    },
  },
  thresholds: {
    ws_delivery_latency: ['p(95)<500'],
  },
};

export function setup() {
  return createWorkspace();
}

export default function (data) {
  const token = joinAsNewUser(data.inviteCode);
  const isSender = __VU % SENDER_RATIO === 0;

  const response = ws.connect(WS_URL, {}, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'auth', token }));
    });

    socket.on('message', (raw) => {
      const event = JSON.parse(raw);
      if (event.type === 'ready' && isSender) {
        socket.setInterval(() => {
          http.post(
            `${BASE_URL}/api/channels/${data.channelId}/messages`,
            JSON.stringify({ content: `ws load ${__VU}`, clientMessageId: uuid() }),
            { ...authHeaders(token), tags: { name: 'send' } },
          );
        }, SEND_EVERY_MS);
      }
      if (event.type === 'message.new') {
        messagesReceived.add(1);
        // Valid because k6 and the server run on the same machine (same clock).
        // Across machines, clock differences would distort this number.
        deliveryLatency.add(Date.now() - Date.parse(event.message.createdAt));
      }
    });

    // Keep the proxy from closing an idle connection.
    socket.setInterval(() => socket.send(JSON.stringify({ type: 'ping' })), 25000);
    socket.setTimeout(() => socket.close(), HOLD_SECONDS * 1000);
  });

  check(response, { 'websocket handshake is 101': (r) => r && r.status === 101 });
}

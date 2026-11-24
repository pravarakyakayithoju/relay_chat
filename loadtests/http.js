// HTTP load test: many users sending messages and reading history.
//
//   k6 run loadtests/http.js
//   k6 run -e VUS=200 -e BASE_URL=http://localhost:8080 loadtests/http.js
//
// What to look at in the output:
//   http_req_duration{name:send}     latency of sending a message
//   http_req_duration{name:history}  latency of loading a channel
//   http_req_failed                  share of failed requests
import { check, sleep } from 'k6';
import http from 'k6/http';
import { BASE_URL, authHeaders, createWorkspace, joinAsNewUser, uuid } from './lib.js';

const VUS = Number(__ENV.VUS || 50);

export const options = {
  scenarios: {
    chat: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: VUS }, // ramp up
        { duration: '1m', target: VUS }, // hold
        { duration: '15s', target: 0 }, // ramp down
      ],
    },
  },
  // The test fails (non-zero exit code) if these are not met - usable as a CI gate.
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:send}': ['p(95)<300'],
    'http_req_duration{name:history}': ['p(95)<300'],
  },
};

export function setup() {
  return createWorkspace();
}

// Module-level variables are per virtual user, so each VU signs up once and keeps its token.
let token = null;

export default function (data) {
  if (!token) token = joinAsNewUser(data.inviteCode);

  // Most traffic in a chat app is reads: open a channel, look at the latest messages.
  const history = http.get(`${BASE_URL}/api/channels/${data.channelId}/messages`, {
    ...authHeaders(token),
    tags: { name: 'history' },
  });
  check(history, { 'history is 200': (r) => r.status === 200 });

  // One message in every three iterations (about one every 3 seconds per user).
  if (__ITER % 3 === 0) {
    const sent = http.post(
      `${BASE_URL}/api/channels/${data.channelId}/messages`,
      JSON.stringify({ content: `load test message ${__VU}-${__ITER}`, clientMessageId: uuid() }),
      { ...authHeaders(token), tags: { name: 'send' } },
    );
    check(sent, { 'send is 201': (r) => r.status === 201 });
  }

  sleep(1);
}

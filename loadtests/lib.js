// Shared helpers for the k6 scripts.
import http from 'k6/http';

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
export const WS_URL = `${BASE_URL.replace(/^http/, 'ws')}/ws`;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function authHeaders(token) {
  return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

/** Sign up a throwaway user and return its token. */
export function signup(prefix) {
  const name = `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const response = http.post(
    `${BASE_URL}/api/auth/signup`,
    JSON.stringify({ username: name, email: `${name}@load.test`, password: 'load-test-password' }),
    { headers: JSON_HEADERS, tags: { name: 'signup' } },
  );
  if (response.status !== 201) {
    throw new Error(
      `signup failed with ${response.status}: ${response.body}. ` +
        'If this is 429, start the stack with AUTH_RATE_LIMIT=1000000 (see loadtests/README.md).',
    );
  }
  return response.json('token');
}

/** Runs once before the test: one owner, one workspace, and its #general channel. */
export function createWorkspace() {
  const ownerToken = signup('owner');
  const workspace = http.post(
    `${BASE_URL}/api/workspaces`,
    JSON.stringify({ name: `Load test ${new Date().toISOString()}` }),
    authHeaders(ownerToken),
  );
  const workspaceId = workspace.json('id');
  const channels = http.get(`${BASE_URL}/api/workspaces/${workspaceId}/channels`, authHeaders(ownerToken));
  const general = channels.json('channels').find((channel) => channel.name === 'general');
  return { inviteCode: workspace.json('inviteCode'), workspaceId, channelId: general.id };
}

/** Sign up a user and join the test workspace (which also joins #general). */
export function joinAsNewUser(inviteCode) {
  const token = signup('vu');
  http.post(`${BASE_URL}/api/workspaces/join`, JSON.stringify({ inviteCode }), {
    ...authHeaders(token),
    tags: { name: 'join' },
  });
  return token;
}

export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

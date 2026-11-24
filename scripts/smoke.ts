/**
 * End-to-end smoke test against a running stack.
 *
 *   docker compose up --build -d
 *   npm run smoke                      # or: BASE_URL=http://localhost:5173 npm run smoke
 *
 * It behaves like two real users (Alice and Bob) and checks the main promises
 * of the system: auth, permissions, idempotent sends, real-time delivery
 * across gateways, presence, and the asynchronous pipeline (outbox -> Kafka ->
 * workers -> notifications and search).
 *
 * Needs Node 22+ (uses the built-in fetch and WebSocket). Exits with code 1 if any check fails.
 */

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const WS_URL = `${BASE_URL.replace(/^http/, 'ws')}/ws`;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    data: text ? JSON.parse(text) : null,
    instance: response.headers.get('x-instance'),
  };
}

/** Poll `fn` until it returns something truthy or the timeout passes. */
async function eventually<T>(fn: () => Promise<T> | T, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  return null;
}

/** Open a WebSocket, authenticate, and collect every event the server pushes. */
async function openSocket(token: string) {
  const events: any[] = [];
  const ws = new WebSocket(WS_URL);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.addEventListener('message', (message) => events.push(JSON.parse(String(message.data))));
  const waitFor = (predicate: (event: any) => boolean, timeoutMs: number) =>
    eventually(() => events.find(predicate), timeoutMs);
  const ready = await waitFor((event) => event.type === 'ready', 5000);
  return { ready: Boolean(ready), waitFor, close: () => ws.close() };
}

async function main(): Promise<void> {
  console.log(`Smoke test against ${BASE_URL}\n`);
  const run = Date.now().toString(36);
  const marker = `zebra${run}`; // a word that only this run's message contains

  // --- auth ---------------------------------------------------------------
  const noToken = await call('GET', '/workspaces');
  check('requests without a token are rejected', noToken.status === 401, `status ${noToken.status}`);

  const alice = await call('POST', '/auth/signup', undefined, {
    username: `alice_${run}`,
    email: `alice_${run}@example.test`,
    password: 'correct-horse-battery',
  });
  const bob = await call('POST', '/auth/signup', undefined, {
    username: `bob_${run}`,
    email: `bob_${run}@example.test`,
    password: 'correct-horse-battery',
  });
  check('two users can sign up', alice.status === 201 && bob.status === 201, `${alice.status}/${bob.status}`);
  if (alice.status !== 201 || bob.status !== 201) return;
  const aliceToken: string = alice.data.token;
  const bobToken: string = bob.data.token;

  const duplicate = await call('POST', '/auth/signup', undefined, {
    username: `alice_${run}`,
    email: `other_${run}@example.test`,
    password: 'correct-horse-battery',
  });
  check('a taken username is refused', duplicate.status === 409, `status ${duplicate.status}`);

  const wrongPassword = await call('POST', '/auth/login', undefined, {
    email: `alice_${run}@example.test`,
    password: 'not-the-password',
  });
  check('a wrong password is refused', wrongPassword.status === 401, `status ${wrongPassword.status}`);

  // --- workspace and channels ---------------------------------------------
  const workspace = await call('POST', '/workspaces', aliceToken, { name: `Smoke ${run}` });
  check('Alice creates a workspace', workspace.status === 201, `status ${workspace.status}`);
  const workspaceId: string = workspace.data.id;

  const joined = await call('POST', '/workspaces/join', bobToken, { inviteCode: workspace.data.inviteCode });
  check('Bob joins with the invite code', joined.status === 200, `status ${joined.status}`);

  const channels = await call('GET', `/workspaces/${workspaceId}/channels`, bobToken);
  const general = channels.data?.channels?.find((c: any) => c.name === 'general');
  check('Bob sees #general and is a member', Boolean(general?.isMember));
  const channelId: string = general.id;

  const secret = await call('POST', `/workspaces/${workspaceId}/channels`, aliceToken, {
    name: 'secret',
    isPrivate: true,
  });
  const intrusion = await call('POST', `/channels/${secret.data.id}/messages`, bobToken, { content: 'let me in' });
  check('Bob cannot post in a private channel he is not in', intrusion.status === 403, `status ${intrusion.status}`);

  // --- real-time ----------------------------------------------------------
  const bobSocket = await openSocket(bobToken);
  check('Bob connects over WebSocket', bobSocket.ready);

  const members = await eventually(async () => {
    const result = await call('GET', `/workspaces/${workspaceId}/members`, aliceToken);
    return result.data?.members?.find((m: any) => m.username === `bob_${run}` && m.online);
  }, 5000);
  check('Alice sees Bob as online (presence)', Boolean(members));

  const clientMessageId = crypto.randomUUID();
  const content = `hello @bob_${run} this is ${marker}`;
  const sent = await call('POST', `/channels/${channelId}/messages`, aliceToken, { content, clientMessageId });
  check('Alice sends a message', sent.status === 201, `status ${sent.status}`);
  const messageId: string = sent.data?.id;

  const retried = await call('POST', `/channels/${channelId}/messages`, aliceToken, { content, clientMessageId });
  check(
    'retrying with the same clientMessageId does not create a second message',
    retried.status === 200 && retried.data?.id === messageId,
    `status ${retried.status}`,
  );

  const pushed = await bobSocket.waitFor((e) => e.type === 'message.new' && e.message.id === messageId, 5000);
  check('Bob receives the message in real time', Boolean(pushed));

  const history = await call('GET', `/channels/${channelId}/messages`, bobToken);
  const copies = history.data?.messages?.filter((m: any) => m.content === content).length;
  check('history contains the message exactly once', copies === 1, `${copies} copies`);

  const tooLong = await call('POST', `/channels/${channelId}/messages`, aliceToken, { content: 'x'.repeat(4001) });
  check('an over-long message is rejected with 400', tooLong.status === 400, `status ${tooLong.status}`);

  // --- asynchronous pipeline (needs the workers and Kafka) ------------------
  const notified = await bobSocket.waitFor(
    (e) => e.type === 'notification.new' && e.notification.messageId === messageId,
    20000,
  );
  check('Bob is notified of the @mention (outbox -> Kafka -> worker)', Boolean(notified));

  const found = await eventually(async () => {
    const result = await call('GET', `/search?workspaceId=${workspaceId}&q=${marker}`, bobToken);
    return result.data?.hits?.some((hit: any) => hit.messageId === messageId);
  }, 20000);
  check('the message becomes searchable (eventual consistency)', Boolean(found));

  // --- load balancing (informational) --------------------------------------
  const instances = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const result = await call('GET', '/me', aliceToken);
    if (result.instance) instances.add(result.instance);
  }
  console.log(`INFO  requests were served by ${instances.size} API instance(s): ${[...instances].join(', ')}`);

  bobSocket.close();
}

main()
  .catch((err) => {
    failures++;
    console.error(`FAIL  smoke test crashed: ${(err as Error).message}`);
    console.error('      Is the stack running? Try: docker compose up --build -d');
  })
  .finally(() => {
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  });

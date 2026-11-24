# Phase 3: Multiple servers

**Problem:** one server is a single point of failure and a hard ceiling. Run
several and a new problem appears: Alice's socket is on gateway A, Bob's is on
gateway B, and gateway A has no way to reach Bob.

This is the central problem of scaling anything with long-lived connections.

## What was built

- Nginx in front, load-balancing the API and the gateways
  (`infra/nginx/nginx.conf`)
- Redis pub/sub between the API and all gateways
- Per-topic subscriptions, so a gateway only receives what it can deliver
- Presence stored in Redis instead of in one process
- Rate-limit counters in Redis instead of in one process

## How fan-out works

```
Alice --POST--> API ----PUBLISH channel:42----> Redis
                                                 |-- gateway A (has Carol) --> Carol
                                                 |-- gateway B (has Bob)   --> Bob
                                                 '-- gateway C (nobody in 42: not subscribed)
```

The API does not know or care which gateway holds whom. It publishes to a
topic named after the channel. Each gateway subscribes to `channel:42` only
while it has at least one connected member of channel 42, and unsubscribes when
the last one leaves (`apps/gateway/src/hub.ts`).

The naive version, where every gateway subscribes to everything and filters
locally, makes every gateway process every message in the system. Adding
gateways then adds no capacity.

## Decisions

### Why Redis pub/sub and not Kafka here

Live delivery wants the lowest latency and does not need durability: the
message is already in Postgres, and a client that misses an event recovers from
history. Redis pub/sub is fire-and-forget and very fast, which is exactly this
shape. Kafka's strengths (durable log, replay, consumer groups) are needed for
background work in phase 4, not here.

### The API became stateless on purpose; the gateway cannot be

Check what the API keeps in memory between requests: nothing. Sessions are
JWTs, rate limits are in Redis, caches are in Redis. That is why Nginx can use
plain round robin for it.

The gateway holds sockets, which is state by definition. Nginx uses
`least_conn` for it so a newly started gateway fills up rather than staying
empty.

### Presence needs a shared home

"Is Bob online?" cannot be answered by one gateway, because Bob may be
connected to another, or to two at once from a laptop and a phone.

```
presence:{userId}   Redis hash   { connectionId: last heartbeat ms }   TTL 90 s
```

Connect adds a field, heartbeat refreshes it, disconnect removes it. Bob is
online while at least one field is fresh. If a gateway crashes without cleaning
up, its fields stop being refreshed and are ignored after 75 seconds, and the
whole key expires after 90. The worst case after a crash is someone shown
online for a minute and a half, never forever. A plain counter
(`INCR`/`DECR`) would drift permanently after the first crash.

Presence changes are published only to the workspaces the user belongs to, not
to everyone.

### Snowflake node ids

Several API processes now generate message ids at once. Each derives a node id
from its hostname, which is part of every id, so two processes cannot mint the
same id in the same millisecond.

## See it yourself

```bash
docker compose up --build -d          # 2 API + 2 gateway replicas by default
npm run smoke                         # last line shows how many API instances answered

for i in 1 2 3 4; do curl -si localhost:8080/api/me | grep -i x-instance; done
```

Scale and watch connections spread:

```bash
docker compose up -d --scale gateway=3 && docker compose restart nginx
docker compose --profile monitoring up -d   # Grafana :3001, "Open WebSocket connections"
```

See the subscriptions a gateway holds:

```bash
docker compose exec redis redis-cli pubsub channels
```

Kill one gateway while two users chat (`docker ps`, then `docker kill <id>`).
Its users reconnect to the other and the conversation continues.

## Where it breaks

- Redis is now on the path of every live message and is a single node.
  Production runs it replicated, and very large systems shard pub/sub or route
  through a dedicated tier.
- A channel with 100,000 members online means one publish becomes 100,000
  socket writes. Large systems treat huge channels differently (delivering to
  only the members who have the channel open).
- Sending still does everything inline. Add notifications, search indexing and
  link previews to the request and it gets slow. → Phase 4

## Questions to be ready for

- Two users are on different servers. How does a message get from one to the other?
- Why not have every gateway subscribe to a single global topic?
- Why can the API use round robin but WebSockets need something else?
- How do you know a user is online when they may be connected to several servers?
- What happens to presence when a gateway crashes?
- What breaks first if a channel has a million members?

# Architecture

## The parts

```
                    Browser (React)
                REST  |        | WebSocket
                      v        v
               +----------------------+
               |  Nginx load balancer |
               +----+------------+----+
                    v            v
          +--------------+  +----------------+
          |  API  (x N)  |  | Gateway (x N)  |
          |  stateless   |  | open sockets   |
          +--+---+---+---+  +-------^--------+
             |   |   |              | subscribe
             |   |   +- publish --> Redis  (pub/sub, cache, presence, rate limits)
             |   |
             |   +-- cache / rate limit --> Redis
             v
          Postgres <--- outbox relay ---> Kafka ---> Workers
       (source of truth)                              |  notifications
             ^                                        |  search index
             +----------------------------------------+  link previews
```

Two ideas organise everything:

1. **Separate the stateless from the stateful.** The API keeps nothing in
   memory between requests, so any instance can serve any request and scaling
   is "run more copies". The gateway is the opposite: its whole job is holding
   long-lived connections. Keeping them apart means each scales for its own
   reason (requests per second versus open connections) and a deploy of the
   API does not disconnect anyone.

2. **Postgres is the source of truth; everything else can be rebuilt from
   it.** Redis holds caches, presence and in-flight events. Kafka carries
   events that originated in Postgres. The search table is derived. Losing
   any of them degrades the product; none of them loses data.

## The life of one message

Alice types "hi @bob" and presses Enter.

| Step | Where | What happens |
|---|---|---|
| 1 | Browser | Generates a `clientMessageId` (UUID) and sends `POST /api/channels/:id/messages`. On a network error it retries with the **same** id. |
| 2 | Nginx | Picks an API instance (round robin). |
| 3 | API | Verifies the JWT signature. No database lookup: the token itself proves who Alice is. |
| 4 | API | Rate limit check: an atomic counter in Redis, shared by every instance. |
| 5 | API | Is Alice in this channel? Answered from a Redis cache, falling back to Postgres. |
| 6 | API | Generates a Snowflake id, then **one transaction**: insert the message, insert an outbox row describing it. If the `clientMessageId` was already used, nothing is inserted and the original message is returned. |
| 7 | API | After commit: delete the cached first page for the channel, publish `message.new` to Redis topic `channel:<id>`, respond `201`. |
| 8 | Gateways | Every gateway with at least one connected member of that channel is subscribed to that topic. Each writes the event to its local sockets. Bob, connected to a different gateway than Alice, receives it. |
| 9 | Workers | The outbox relay reads the new outbox row and publishes it to Kafka, keyed by channel id. |
| 10 | Workers | Three consumer groups each receive the event: one creates Bob's mention notification and pushes it to topic `user:<bob>`, one copies the message into the search table, one fetches a preview if the message contains a link. |

Steps 1 to 8 are the fast path and take milliseconds. Steps 9 and 10 are
asynchronous: the user never waits for them, and if the workers are down they
simply catch up later.

## Why two delivery paths

A message leaves the API twice, on purpose.

| | Redis pub/sub | Outbox + Kafka |
|---|---|---|
| Used for | Showing the message on screens now | Notifications, search, previews |
| Speed | Sub-millisecond | Tens to hundreds of milliseconds |
| If nobody is listening | The event is gone | The event waits |
| Guarantee | At most once | At least once |
| Cost of losing an event | None: clients reload history on reconnect | A missing notification or search result, so it must not happen |

Live delivery needs to be fast and can afford to be lossy, because the message
is safely in Postgres and the client can always refetch. Background work needs
to be reliable and can afford to be slightly late. Using one mechanism for
both would make one of them worse.

## Real-time routing

The gateway keeps one map: `topic -> set of local connections`.

- `channel:<id>` for messages, typing and link previews in a channel
- `workspace:<id>` for presence changes and channel/member list changes
- `user:<id>` for notifications and "your memberships changed"

A gateway subscribes to a Redis topic when its first local connection needs it
and unsubscribes when the last one leaves. So each gateway only receives
traffic it can deliver, and a quiet gateway does almost no work.

When a user joins a channel, the API publishes `membership.changed` to
`user:<id>`. The gateway holding that user's sockets re-reads their memberships
from Postgres and adjusts subscriptions. This is the only time the gateway
queries the database after a connection is established.

## What happens when something fails

| Failure | Effect | Why it is contained |
|---|---|---|
| One API instance dies | Nginx sends requests to the others | The API is stateless |
| One gateway dies | Its users are disconnected, reconnect to another gateway within seconds (with jittered backoff), and reload the latest messages | Clients treat REST history as truth and the socket as a hint |
| Redis is down | Sending still works. No live delivery, no presence, cache misses hit Postgres, rate limiting is skipped | Every Redis call on the request path is best effort and fails open |
| Kafka is down | Sending still works. Outbox rows pile up and are relayed when Kafka returns | The event was committed to Postgres with the message |
| Workers are down | Same as above: a backlog, then catch-up | Consumer groups remember their offset |
| A worker crashes mid-event | The event is delivered again | Handlers are idempotent |
| One event always fails | Retried 3 times, then parked on the dead-letter topic | One poison message cannot block a partition |
| Postgres is down | The product is down | It is the single source of truth. The fix is replication and failover, outside this project's scope |
| Client sends the same message twice | One message is stored | `clientMessageId` unique constraint |
| A slow client stops reading | Its connection is dropped once 1 MB is buffered | Protects the gateway's memory |

## Data model

```
users --< workspace_members >-- workspaces --< channels --< channel_members >-- users
                                                  |
                                                  +--< messages (8 hash partitions by channel_id)
                                                  +--< link_previews, notifications, message_search

outbox   events waiting to be relayed to Kafka
```

- `messages` has primary key `(channel_id, id)`. `id` is a Snowflake: sortable
  by time, generated by the API without asking the database.
- `channel_members.last_read_message_id` is the read marker. Unread means "the
  channel's newest message id is greater than my marker".
- `message_search` is a derived copy with a `tsvector` column and a GIN index.

The migrations in `apps/api/src/db/migrations/` are the authoritative schema
and are commented.

## Consistency, stated plainly

| Data | Guarantee |
|---|---|
| A sent message | Durable once the API responds. Strongly consistent on the primary. |
| Message order in a channel | By Snowflake id: time order, ties broken by node and sequence. Two API instances with clocks a few ms apart can order near-simultaneous messages differently from wall-clock order, but every client sees the same order. |
| Live delivery | At most once, best effort. Repaired on reconnect. |
| Notifications, search, previews | Eventually consistent, normally well under a second behind. |
| Presence | Eventually consistent. Wrong for at most ~90 seconds after a gateway crash. |
| Membership checks | Cached up to 60 seconds, invalidated on join and leave. |
| First page of history | Cached up to 30 seconds, invalidated on every new message. |

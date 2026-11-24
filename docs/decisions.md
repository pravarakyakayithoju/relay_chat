# Design decisions

Each entry records a choice, what else was considered, and what the choice
costs. Being able to explain the option you rejected is most of what "design
experience" means.

## 1. A monorepo with separate services, run with tsx

**Decision.** One repository with npm workspaces: `apps/api`, `apps/gateway`,
`apps/workers`, `apps/web`, and `packages/shared` for the types and event
contracts they all use. Backend TypeScript runs directly with `tsx`.

**Alternatives.** One process doing everything (simplest, but API deploys
would disconnect every WebSocket and the two could not scale separately). One
repository per service (independent versions, but every contract change spans
several pull requests).

**Cost.** One shared `node_modules`, one image containing all three services'
code, and no compile step in the image (see phase 8).

## 2. Messages are sent over HTTP, not the WebSocket

**Decision.** `POST /channels/:id/messages` to send; the socket only pushes.

**Why.** A request/response gives each send a definite outcome, status codes,
rate limiting and idempotent retries. Over a socket all of that has to be
rebuilt by hand (acknowledgement ids, timeouts, error frames).

**Cost.** One extra HTTP round trip per message compared with reusing the open
socket. Irrelevant at human typing speed.

## 3. Redis pub/sub for live fan-out

**Decision.** The API publishes to per-channel Redis topics; gateways subscribe
only to topics their connected users need.

**Alternatives.** Kafka for everything (durable, but slower, and durability is
wasted on events the client can refetch). Gateways calling each other directly
(needs service discovery and a map of who is connected where). Sticky routing
of whole channels to one gateway (breaks for users in many channels).

**Cost.** Delivery is at-most-once. Redis is a single point for live updates.
Clients must repair gaps from history, which they do on every reconnect.

## 4. Transactional outbox for background events

**Decision.** Events are inserted into an `outbox` table in the same
transaction as the message; a relay publishes them to Kafka.

**Alternatives.** Publish to Kafka from the request (loses events on a crash
between the two writes). Change data capture with Debezium (no polling, the
standard at large scale, but another moving part). Use Postgres itself as the
queue (fine at small scale; no independent consumer groups or replay).

**Cost.** At-least-once delivery, so every consumer must be idempotent. A
polling delay of up to 250 ms. A table that needs pruning.

## 5. Partitioned Postgres instead of Cassandra

**Decision.** Messages stay in Postgres, hash-partitioned by `channel_id`,
with Snowflake ids.

**Why not Cassandra/ScyllaDB.** It is the right tool when message volume
exceeds what one primary can write, and it is what Discord uses. But it needs
several GB of memory to run, a different query model, and brings no visible
benefit below that scale. This project is meant to run completely on a
student laptop at no cost.

**What is preserved.** The two things that make the move possible later: every
message query carries the partition key, and ids need no central counter. The
Cassandra table would be `PRIMARY KEY ((channel_id, bucket), message_id)` with
`CLUSTERING ORDER BY (message_id DESC)`; the outbox would be replaced by change
data capture, since Cassandra has no multi-table transaction.

**Cost.** One primary still takes every write. Partitioning organises the data;
it does not add write capacity.

## 6. Search read model in Postgres instead of Elasticsearch

**Decision.** A separate `message_search` table with a GIN full-text index,
filled asynchronously by a Kafka consumer.

**Why not Elasticsearch/OpenSearch.** Same reasoning as above: 1-2 GB of
memory for a JVM cluster, to demonstrate an architecture that is identical
either way. The pattern (separate read model, built from events, eventually
consistent, rebuildable by replay) is the thing worth learning, and it is all
here.

**To switch.** Change two files: the indexer writes documents to the search
engine instead of a table, and the search route queries it.

**Cost.** No typo tolerance, relevance tuning or highlighting; the index shares
the primary database's resources.

## 7. Redpanda as the Kafka broker

**Decision.** Local development uses Redpanda, which implements the Kafka
protocol.

**Why.** One container, no ZooKeeper, no JVM, about 500 MB. The application
uses the standard `kafkajs` client and would run unchanged against Apache
Kafka or a managed Kafka service.

## 8. Presence as heartbeat timestamps, not a counter

**Decision.** A Redis hash per user mapping connection id to last heartbeat,
with a TTL.

**Alternative.** `INCR` on connect, `DECR` on disconnect. Simpler, and wrong
forever after the first gateway crash, because the decrements never happen.

**Cost.** One small write per connection every 30 seconds, and up to ~90
seconds of stale "online" after a crash.

## 9. Fail open on Redis

**Decision.** Cache lookups, rate limiting and event publishing treat a Redis
error as "no cache", "allowed" and "skipped".

**Why.** Redis holds nothing that cannot be recomputed. Coupling the product's
availability to it would turn a cache outage into a full outage.

**Cost.** During a Redis outage there is no rate limiting, and Postgres takes
the full read load.

# Phase 4: Asynchronous work

**Problem:** sending a message has side effects: notify mentioned users, index
it for search, fetch a preview for any link. Doing these inside the request
makes every send as slow as the slowest of them, and fetching someone else's
website can take seconds or hang. If any of them fails, should the send fail?

**Solution:** the request does the minimum (store the message, announce it)
and hands the rest to background workers through a durable queue.

## What was built

- Idempotent sends with `clientMessageId`
- A transactional outbox (`outbox` table, `apps/workers/src/outboxRelay.ts`)
- Kafka topic `chat.message-events` (Redpanda locally)
- Three independent consumers (`apps/workers/src/handlers/`)
- Retries, then a dead-letter topic (`apps/workers/src/consumer.ts`)

## The dual-write problem and the outbox

The API must do two things: save the message in Postgres, and publish an event
to Kafka. They are two different systems, so there is no transaction across
them.

| Order | Crash in between means |
|---|---|
| Save, then publish | Message exists, event lost: no notification, never searchable |
| Publish, then save | Event exists for a message that was never saved |

The outbox pattern removes the second system from the request:

```sql
BEGIN;
  INSERT INTO messages (...);
  INSERT INTO outbox (topic, key, payload) VALUES (...);   -- same transaction
COMMIT;
```

Both rows commit or neither does. A separate relay process reads unpublished
outbox rows, sends them to Kafka, and marks them published. If the relay
crashes after sending but before marking, it sends again on restart.

So the guarantee is **at least once**: an event is never lost, but may arrive
twice. "Exactly once" delivery across systems does not exist in general; what
systems actually do is at-least-once delivery plus consumers that tolerate
duplicates.

## Idempotent consumers

Every handler is written so that running it twice has the same result as
running it once:

| Handler | How it tolerates a duplicate |
|---|---|
| Notifications | `UNIQUE (user_id, message_id, type)` with `ON CONFLICT DO NOTHING`; only pushes for rows it actually inserted |
| Search indexer | Primary key is the message id; `ON CONFLICT DO NOTHING` |
| Link previews | Checks for an existing preview before fetching |

This was tested by delivering every event twice on purpose: one notification
and one search row per message.

The same idea protects sending. The client attaches a UUID to each message and
reuses it on retry; a unique constraint on `(channel_id, user_id,
client_msg_id)` makes the retry a no-op that returns the original message.
Without it, a timeout followed by a retry posts the message twice.

## Other decisions

### Consumer groups

Each worker type is its own consumer group, so each receives every event and
tracks its own position. A slow or broken link-preview worker does not delay
notifications.

### Partition key = channel id

Kafka keeps order only within a partition. Keying by channel sends all of one
channel's events to the same partition, in order, while different channels are
processed in parallel. The topic has 3 partitions, so each worker type can run
up to 3 instances.

### Poison messages

If a handler throws, it is retried 3 times with exponential backoff. If it
still fails, the event is written to `chat.message-events.dlq` with the error
and the consumer moves on. Otherwise one bad event would block everything
behind it on that partition forever.

### `FOR UPDATE SKIP LOCKED`

The relay selects its batch with this clause, so several relay instances can
run at once: each locks different rows instead of waiting on the others.

### Link previews and SSRF

The preview worker fetches URLs that users typed. Unchecked, a user could post
`http://169.254.169.254/...` (cloud metadata) or `http://postgres:5432` and
make the server request internal services. The worker resolves each hostname,
refuses private, loopback and link-local addresses, follows redirects by hand
so every hop is checked, and caps time and response size. The remaining gap
(DNS rebinding) is described in `linkPreview.ts`.

## See it yourself

Stop the workers and keep chatting:

```bash
docker compose stop workers
# send a few messages mentioning someone - sending is as fast as before
docker compose exec postgres psql -U chat chat -c \
  "SELECT count(*) FROM outbox WHERE published_at IS NULL"
docker compose start workers
# the backlog drains; the notifications arrive
```

Read the event stream:

```bash
docker compose exec redpanda rpk topic consume chat.message-events -n 3
docker compose exec redpanda rpk group describe relay-notifications
```

## Where it breaks

- Every "open channel" still queries Postgres for the same recent messages. → Phase 5
- The relay polls. At very high volume, systems read the database's
  write-ahead log instead (change data capture, e.g. Debezium).

## Questions to be ready for

- What is the dual-write problem? Why can you not just write to both?
- At-most-once, at-least-once, exactly-once: what does each mean and which do you really get?
- What makes an operation idempotent? Give an example from this project.
- What is a dead-letter queue for?
- How does Kafka preserve ordering, and what does the partition key have to do with it?
- A user double-clicks Send on a bad connection. Walk through what happens.

# Phase 5: Read scaling

**Problem:** chat is read-heavy. Every time anyone opens a channel the API asks
Postgres for the same latest 50 messages, and every send and read first asks
"is this user in this channel?". The database answers identical questions
thousands of times.

**Solution:** answer repeated questions from memory (a cache), and give reads
that can tolerate slight staleness somewhere else to go (a replica).

## What was built

- Membership cache: `member:{channelId}:{userId}` → `1` or `0`, 60 s TTL
  (`apps/api/src/modules/channels/service.ts`)
- First-page cache: `recent:{channelId}` → the latest page as JSON, 30 s TTL
  (`apps/api/src/modules/messages/service.ts`)
- Optional read replica: set `DATABASE_READ_URL` and history and search read
  from it (`apps/api/src/db/pool.ts`)
- Cache hit/miss metrics

## Cache-aside

```
read:   look in Redis  --hit-->  return it
                       --miss--> read Postgres, store in Redis with a TTL, return it
write:  change Postgres, then DELETE the cache key
```

The application manages the cache; Postgres knows nothing about it. On a write
the key is deleted, not updated: deleting is always safe, while two concurrent
updates can leave the older value in the cache.

### What to cache

Not everything. Only the first page of history is cached, because that is what
every channel open requests. Page 37 of an old channel is asked for once and
caching it would only use memory. A good cache candidate is read often, changes
rarely relative to how often it is read, and is expensive to compute.

### Invalidation, and the race that remains

The cached page is deleted on every new message, and when a link preview is
added. There is still a window:

```
Reader:  cache miss -> reads Postgres (does not see message M yet)
Writer:                 inserts M, deletes the cache key
Reader:                                               stores its stale page
```

Now the cache holds a page without M. This cannot be fully prevented with
cache-aside; it is bounded instead. The TTL limits it to 30 seconds, connected
clients already received M over the socket, and the next message deletes the
key again. Stricter fixes exist (versioned keys, short locks, writing through
the cache) and cost complexity. Knowing that this race exists and what bounds
it is the point.

### The cache must never be required

Every cache call is wrapped so a Redis failure counts as a miss
(`apps/api/src/lib/redis.ts`). If Redis is down, the product is slower, not
broken.

## Read replicas

A replica is a second Postgres that continuously copies the primary. Reads go
to replicas, writes to the primary, and you add replicas as reads grow.

The cost is **replication lag**: a replica is a few milliseconds to seconds
behind. The classic bug is "read your own writes": a user sends a message, the
page refetches from a replica that does not have it yet, and their own message
is missing. So the split is by tolerance for staleness:

| Query | Reads from | Why |
|---|---|---|
| Message history, search | Replica | Slightly stale is fine; the live event already delivered anything new |
| Membership checks, anything inside a transaction | Primary | Must be current |

Docker Compose does not start a replica, to keep the stack light. The code path
exists; pointing `DATABASE_READ_URL` at a streaming replica activates it.

## See it yourself

```bash
docker compose --profile monitoring up -d
# Grafana :3001 -> "Cache hit ratio" while you click between channels
docker compose exec redis redis-cli --scan --pattern 'recent:*'
docker compose exec redis redis-cli ttl recent:<channel id>
```

Measure the difference:

```bash
k6 run loadtests/http.js                                        # cache on
RECENT_CACHE_TTL_SECONDS=0 docker compose up -d api
k6 run loadtests/http.js                                        # cache off
```

Compare `http_req_duration{name:history}` and record both in
`docs/benchmarks.md`.

## Where it breaks

- **Cache stampede:** when a hot key expires, many requests miss at once and
  all hit the database. Fixes: let one request rebuild while others wait, or
  refresh shortly before expiry.
- Caching and replicas only help reads. Every write still lands on one table
  on one primary. → Phase 6

## Questions to be ready for

- Explain cache-aside. Why delete on write instead of updating?
- What is the hardest part of caching? Describe a concrete stale-cache race.
- How do you choose a TTL?
- What is replication lag, and what bug does it cause for a user who just wrote something?
- What should happen when the cache is down?
- What is a cache stampede?

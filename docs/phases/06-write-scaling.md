# Phase 6: Write scaling

**Problem:** messages are the one table that grows without limit. As it grows,
its indexes stop fitting in memory, inserts and maintenance slow down, and
every channel's data is mixed with every other channel's.

**Solution:** partition the table by channel, with ids that do not depend on a
central counter.

## What was built

- `messages` split into 8 hash partitions on `channel_id`
  (`apps/api/src/db/migrations/003_partition_messages.sql`)
- Snowflake ids generated in the API (`packages/shared/src/snowflake.ts`)
- Primary key `(channel_id, id)`

## Partitioning

One logical table, eight physical ones. Postgres hashes `channel_id` to pick
the partition. Because every hot query filters on `channel_id`, it touches
exactly one partition. This is the real query plan from this schema:

```
Limit
  ->  Index Only Scan Backward using messages_p7_pkey on messages_p7 m
        Index Cond: ((channel_id = '2000...0005'::uuid) AND (id < 900003))
```

One partition (`messages_p7`), one index, read backwards for "newest first",
no sort step.

### Choosing the partition key

This is the decision that matters, and it is the same one you make when
sharding across servers.

| Candidate | Problem |
|---|---|
| `user_id` | Reading a channel would need every partition |
| `created_at` (by month) | Good for deleting old data; but one channel's history spreads over many partitions and all current writes hit the newest one |
| `channel_id` | Every read and write for a channel hits one partition ✔ |

The rule: partition by what your main queries filter on.

### What it costs

- **Every unique constraint must include the partition key.** That is why the
  primary key changed from `(id)` to `(channel_id, id)`.
- **Queries without the key scan every partition.** "All messages by this
  user" is now expensive. That is acceptable only because the product has no
  such query; search (phase 7) has its own table.
- **Hot partitions.** Hashing spreads channels evenly but not load: one
  enormous channel still lives in one partition. Discord's real answer is a
  compound key of channel plus a time bucket, so even one channel's history is
  split.

## Snowflake ids

```
| 41 bits: milliseconds since 2024 | 10 bits: node id | 12 bits: sequence |
```

| Option | Why not |
|---|---|
| `SERIAL` / auto-increment | A single counter in a single database: a coordination point that does not survive sharding |
| Random UUID | Not ordered by time. Inserts land all over the index, and it cannot be the pagination cursor |
| Snowflake | Generated locally by any API process, sortable by time, 64 bits ✔ |

The id is the timestamp, the sort key and the pagination cursor at once.

Costs to know about: each process needs a distinct node id (here hashed from
the hostname; a collision would cause a primary-key error, loud rather than
silent); ordering across nodes is only as good as their clocks; and if a clock
jumps backwards the generator keeps using its last timestamp so ids never
decrease.

Message ids are 64-bit integers, larger than a JavaScript number can represent
exactly, so they travel as strings in JSON everywhere.

## From partitions to shards

Partitioning keeps everything on one server; it makes the table manageable but
does not add write capacity. Sharding is the same idea across servers: channels
whose hash is 0-3 on database A, 4-7 on database B. The partition key becomes
the shard key, and the application or a router picks the server.

Everything hard about sharding is already visible here: no cross-shard unique
constraints, no cheap cross-shard queries, hot keys. Having ids that need no
central counter and a key that every query carries are the two prerequisites,
and both are in place.

**Why not Cassandra or ScyllaDB?** That is what Discord uses for messages, and
it would be the next step at real scale: a database built around a partition
key, with replication and no single primary. It was left out so the whole
stack runs on a laptop. The data model would carry over directly:
`PRIMARY KEY ((channel_id, bucket), message_id)`. See
[decisions.md](../decisions.md#5-partitioned-postgres-instead-of-cassandra).

## See it yourself

```bash
docker compose exec postgres psql -U chat chat
```

```sql
\d+ messages                                   -- lists the 8 partitions

-- how rows are spread
SELECT tableoid::regclass AS partition, count(*) FROM messages GROUP BY 1 ORDER BY 1;

-- with the key: one partition
EXPLAIN SELECT * FROM messages WHERE channel_id = '<id>' ORDER BY id DESC LIMIT 50;

-- without the key: all eight
EXPLAIN SELECT * FROM messages WHERE user_id = '<id>';
```

## Where it breaks

"Find messages containing this word" has no channel id and no usable index. → Phase 7

## Questions to be ready for

- How do you choose a partition or shard key? What goes wrong with a bad one?
- What is a hot partition and how would you deal with one?
- Why not auto-increment ids in a distributed system? Why not UUIDs?
- What can you no longer do cheaply once a table is sharded?
- Partitioning versus sharding versus replication: what does each solve?
- How would you migrate a large live table to a partitioned one without downtime?

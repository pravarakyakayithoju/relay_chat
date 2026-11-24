# Phase 7: Search

**Problem:** "find messages containing *deployment*" does not fit the messages
table. There is no channel id to pick a partition, and `content LIKE '%word%'`
cannot use an ordinary index, so it reads every row. Search also wants things
the write model does not: stemming ("deploy" matches "deployment"), ranking,
phrase matching.

**Solution:** a second copy of the data, shaped for searching, kept up to date
from the event stream.

## What was built

- `message_search` table with a `tsvector` column and a GIN index
  (`apps/api/src/db/migrations/004_search.sql`)
- A search-indexer worker that fills it from Kafka
  (`apps/workers/src/handlers/searchIndexer.ts`)
- `GET /api/search` (`apps/api/src/modules/search/routes.ts`)

## Two models for two jobs (CQRS)

```
write:   API --> messages                      (optimised for "append" and "latest N in a channel")
              \-> outbox --> Kafka --> indexer --> message_search
read:    API <----------------------------------- message_search   (optimised for "contains these words")
```

The write path never touches the search table. That separation buys:

- Sending stays fast no matter how expensive indexing is.
- The index can lag, break or be rebuilt without affecting chat.
- The search store can be replaced without changing the write path.

The cost is **eventual consistency**: a message is searchable a moment after it
is sent, not at the same instant. For search that is invisible to users. It
would not be acceptable for, say, a bank balance, which is why you choose per
feature.

## How full-text search works

The indexer stores each message; Postgres computes a search document for it:

```sql
SELECT to_tsvector('english', 'The deployment pipelines are failing');
-- 'deploy':2 'fail':5 'pipelin':3
```

Lowercased, stop words removed, words reduced to stems. A GIN index is an
**inverted index**: for each stem, the list of rows containing it, like the
index at the back of a book. A query is turned into stems the same way and
looked up directly; no rows are scanned.

`websearch_to_tsquery` accepts what people type into a search box: quoted
phrases, `or`, `-exclude`.

## Decisions

### Permissions are applied at query time

The search query joins `channels` and `channel_members`, so results from a
private channel are returned only to its members. The alternative, copying
permissions into the index, goes stale whenever membership changes.

### Rebuildable by replay

The indexer is an idempotent consumer keyed on message id. To rebuild the
index (new stemming rules, a bug, a new store) you empty the table and reset
the consumer group to the start of the topic; it reads every event again.
A derived store you can delete and regenerate is the main benefit of keeping
an event log.

### Postgres instead of Elasticsearch

The read model lives in the same Postgres, in its own table. A dedicated
search engine adds relevance tuning, typo tolerance, highlighting and
horizontal scaling, and costs a JVM cluster and 1-2 GB of memory. The
architecture is what matters and is unchanged either way: to switch, the
indexer writes documents to OpenSearch and the search route queries it. See
[decisions.md](../decisions.md#6-search-read-model-in-postgres-instead-of-elasticsearch).

## See it yourself

Send a message, then search for a word from it; then search for a different
form of the word ("deploying" for "deployment").

```bash
docker compose exec postgres psql -U chat chat
```

```sql
SELECT content, tsv FROM message_search ORDER BY message_id DESC LIMIT 3;
EXPLAIN SELECT * FROM message_search WHERE tsv @@ websearch_to_tsquery('english', 'deploy');
```

See the lag: stop the workers, send a message, search (nothing), start the
workers, search again (found).

Rebuild the index from the log:

```bash
docker compose stop workers
docker compose exec postgres psql -U chat chat -c "TRUNCATE message_search"
docker compose exec redpanda rpk group seek relay-search --to start
docker compose start workers
```

## Where it breaks

- Results are ordered by recency, not relevance (`ts_rank` would add that).
- No typo tolerance or partial-word matching.
- Edited or deleted messages would need `message.updated` and
  `message.deleted` events; the product has neither feature yet.
- Topic retention: replaying from the start only works while the log still
  holds everything. Long-lived systems rebuild from the database instead.

## Questions to be ready for

- Why not search the messages table directly?
- What is an inverted index?
- What is CQRS? What does it cost?
- What does "eventually consistent" mean for a user of this feature? Where would it be unacceptable?
- How would you rebuild the index with no downtime?
- How do you stop search from leaking private channels?

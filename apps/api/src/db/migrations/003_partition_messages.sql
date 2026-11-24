-- Phase 6: write scaling.
-- Split the messages table into 8 hash partitions keyed by channel_id.
--
-- Every hot query filters on channel_id, so Postgres can route each read and
-- write to exactly one partition (partition pruning). Each partition has its
-- own, smaller indexes. It is the same idea as sharding, inside one database:
-- the partition key chosen here is the shard key you would use later to
-- spread channels over several database servers.
--
-- Rule that shapes the design: on a partitioned table every unique constraint
-- must contain the partition key. That is why the primary key becomes
-- (channel_id, id) instead of just (id).

ALTER TABLE messages RENAME TO messages_unpartitioned;

CREATE TABLE messages (
  id            BIGINT NOT NULL,
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id),
  content       TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  client_msg_id UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Also serves "latest N messages in a channel": Postgres scans it backwards.
  CONSTRAINT messages_part_pkey PRIMARY KEY (channel_id, id),
  CONSTRAINT messages_part_client_msg_key UNIQUE (channel_id, user_id, client_msg_id)
) PARTITION BY HASH (channel_id);

CREATE TABLE messages_p0 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE messages_p1 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE messages_p2 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE messages_p3 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE messages_p4 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE messages_p5 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE messages_p6 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE messages_p7 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 7);

-- Copy existing rows across. Fine for a small table inside one transaction;
-- on a large live table you would backfill in batches and dual-write instead.
INSERT INTO messages (id, channel_id, user_id, content, client_msg_id, created_at)
SELECT id, channel_id, user_id, content, client_msg_id, created_at
FROM messages_unpartitioned;

DROP TABLE messages_unpartitioned;

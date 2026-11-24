-- Phase 4: asynchronous work.
-- Idempotent sends, the transactional outbox, and the tables the workers fill in.

-- A client-generated key makes "send message" safe to retry: the same
-- (channel, user, key) can only ever create one row.
ALTER TABLE messages ADD COLUMN client_msg_id UUID;
ALTER TABLE messages
  ADD CONSTRAINT messages_client_msg_key UNIQUE (channel_id, user_id, client_msg_id);

-- Transactional outbox: events are inserted in the same transaction as the
-- data change, then a relay publishes them to Kafka. Either both the message
-- and its event exist, or neither does.
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  topic        TEXT NOT NULL,
  key          TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
-- Partial index: the relay only ever looks for unpublished rows, and there are few of them.
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

CREATE TABLE notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL,
  actor_id   UUID NOT NULL REFERENCES users(id),
  preview    TEXT NOT NULL,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Makes the notification worker idempotent: reprocessing an event cannot notify twice.
  UNIQUE (user_id, message_id, type)
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);

CREATE TABLE link_previews (
  message_id  BIGINT PRIMARY KEY,
  channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  title       TEXT,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

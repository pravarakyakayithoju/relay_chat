-- Phase 7: search.
-- A separate read model, filled asynchronously by the search-indexer worker
-- from the Kafka event stream. The write path (messages) never touches it,
-- so search can lag, be rebuilt, or be moved to a dedicated search engine
-- without affecting sending messages.

CREATE TABLE message_search (
  message_id   BIGINT PRIMARY KEY,
  channel_id   UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  user_id      UUID NOT NULL,
  content      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  -- Pre-computed search document: lowercased, stemmed, stop words removed.
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX message_search_tsv_idx ON message_search USING GIN (tsv);
CREATE INDEX message_search_workspace_idx ON message_search (workspace_id, message_id DESC);

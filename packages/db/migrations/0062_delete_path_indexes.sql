-- migrate: no-transaction
-- DBA review: deleting a conversation sets retrieval_traces.message_id to NULL for each of its messages,
-- and deleting a model does the same on ai_calls; without these indexes each delete reads the whole
-- table. Built CONCURRENTLY (outside a transaction) so writes carry on meanwhile. A build that fails
-- leaves an INVALID index behind: drop it and run the migration again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS retrieval_traces_message ON app.retrieval_traces (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_calls_model ON app.ai_calls (model_id) WHERE model_id IS NOT NULL;

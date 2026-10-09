-- Per-principal chat quotas (plan.md §8.6 "per-customer chat quotas"): questions per rolling
-- 24 hours. Customers are public users; employees get a higher ceiling against runaway scripts.
ALTER TABLE core.settings
  ADD COLUMN chat_daily_limit_customer int NOT NULL DEFAULT 50 CHECK (chat_daily_limit_customer BETWEEN 1 AND 10000),
  ADD COLUMN chat_daily_limit_employee int NOT NULL DEFAULT 500 CHECK (chat_daily_limit_employee BETWEEN 1 AND 100000);

-- Counting a principal's recent questions (RLS already limits app.messages to their conversations).
CREATE INDEX messages_user_recent ON app.messages (conversation_id, created_at) WHERE role = 'user';

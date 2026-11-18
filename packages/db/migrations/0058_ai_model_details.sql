-- Settings › AI model picker: a short description of each model and how much text it takes in
-- (its context window, in tokens), shown when choosing a model for a capability.
ALTER TABLE core.ai_models
  ADD COLUMN description    text CHECK (length(description) <= 300),
  ADD COLUMN context_tokens int CHECK (context_tokens > 0);

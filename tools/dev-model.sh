#!/bin/sh
# Local model for `pnpm dev` (plan.md §6: Ollama locally, vLLM in AWS). Runs `ollama serve` in the
# foreground so its log (requests, model loading, timings) shows in the console; prompts and answers
# come from the API with MODEL_DEBUG=true. OLLAMA_DEBUG=1 or 2 adds Ollama's debug and per-token lines.
# The Ollama menu-bar app runs its own server on the same port, so it is quit first.
# The API uses the server when .env sets MODEL_ENDPOINT=http://localhost:11434/v1 and
# MODEL_NAME=gemma4:e2b (`ollama pull gemma4:e2b`).
if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama is not installed: chat answers list the records it found (no model). See README → Model."
  exit 0
fi

up() { curl -sf http://localhost:11434/api/version >/dev/null 2>&1; }

if up && pgrep -xq Ollama; then
  echo "Quitting the Ollama app so this console owns the server (reopen it from Applications later)."
  pkill -x Ollama
  pkill -f "Ollama.app/Contents/Resources/ollama serve"
  i=0
  while up && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
fi
if up; then
  echo "Another Ollama server is already on http://localhost:11434; using it (its log is not shown here)."
  exit 0
fi

exec ollama serve

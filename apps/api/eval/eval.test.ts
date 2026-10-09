import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runEval } from './harness';

/**
 * Evaluation set v1 (plan.md §10).
 * - `pnpm test` (CI): evidence-only mode. Deterministic paths must all pass and the release gate
 *   (no leaks, no access bypasses, injections without effect) must hold.
 * - `pnpm --filter @joybot/api eval:model`: the same cases against MODEL_ENDPOINT (vLLM/Ollama);
 *   gate failures fail the run, other results go to eval/reports for comparison.
 */
const mode = process.env.EVAL_MODE === 'model' ? 'model' : 'evidence-only';

describe(`evaluation set (${mode})`, () => {
  it(
    'meets the release gate',
    async () => {
      const run = await runEval({
        mode,
        filter: process.env.EVAL_FILTER,
        reportDir: process.env.EVAL_REPORT_DIR ?? path.resolve(__dirname, 'reports'),
      });
      console.log(run.report);
      expect(run.summary.gateFailures).toEqual([]);
      if (mode === 'evidence-only') {
        // Without a model only deterministic paths are scored, and they must all pass.
        expect(run.results.filter((r) => r.applicable && !r.pass).map((r) => r.id)).toEqual([]);
      }
    },
    mode === 'model' ? 1_800_000 : 120_000,
  );
});

/**
 * Phase 8 — workflow execution engine.
 *
 * Runs an ordered list of steps, each with retry and per-step idempotency so a
 * redelivered trigger never repeats a completed step. Steps are small async
 * units; a real deployment would persist step state to resume across restarts.
 */
import { logger } from "@/lib/observability/logger";
import { idempotencyStore } from "./idempotency";
import { withRetry } from "./retry";

export interface WorkflowStep {
  name: string;
  run: () => Promise<void>;
}

export class WorkflowEngine {
  constructor(
    private readonly name: string,
    private readonly runId: string,
  ) {}

  async run(steps: WorkflowStep[]): Promise<void> {
    for (const step of steps) {
      const key = `wf:${this.name}:${this.runId}:${step.name}`;
      await idempotencyStore.runOnce(key, new Date().toISOString(), async () => {
        await withRetry((attempt) => {
          logger.debug("workflow step", { workflow: this.name, step: step.name, attempt, runId: this.runId });
          return step.run();
        }, { attempts: 3, baseMs: 20 });
      });
    }
    logger.info("workflow complete", { workflow: this.name, runId: this.runId });
  }
}

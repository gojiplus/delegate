import type { TaskList } from "graphile-worker";
import type { App } from "../app.js";
import { cancelInFlight, dispatch, processInbox, reconcile } from "../kernel/execution.js";

// Thin adapters from durable jobs to kernel operations. Each operation is
// safe to run twice: status compare-and-set and the per-intent idempotency key
// make a repeated job a no-op, which is what at-least-once delivery requires.
export function taskList(app: App): TaskList {
  const k = app.kernel;
  return {
    dispatch: async (p) => {
      await dispatch(k, (p as { intentId: string }).intentId);
    },
    reconcile: async (p) => {
      const { intentId, attempt } = p as { intentId: string; attempt?: number };
      await reconcile(k, intentId, attempt ?? 0);
    },
    process_inbox: async (p) => {
      const { provider, eventId } = p as { provider: string; eventId: string };
      await processInbox(k, provider, eventId);
    },
    cancel_in_flight: async (p, helpers) => {
      const { intentId } = p as { intentId: string };
      const r = await cancelInFlight(k, intentId);
      // No provider operation yet: try again once dispatch has one.
      if (r === "retry_later") {
        await helpers.addJob(
          "cancel_in_flight",
          { intentId },
          { runAt: new Date(Date.now() + 10_000), jobKey: `cancel:${intentId}` },
        );
      }
    },
  };
}

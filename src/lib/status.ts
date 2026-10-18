import { getActivePrompt } from "./prompt";
import { latestRun, reapStaleRuns, sourceRuns } from "./repo/runs";
import { videoStats } from "./repo/videos";
import { getTokens } from "./repo/tokens";

export type StatusPayload = {
  run: {
    id: number;
    status: string;
    phase: string | null;
    progress: { done?: number; total?: number; message?: string } | null;
    error: string | null;
    started_at: string;
  } | null;
  sources: { source: string; status: string; items_found: number; items_new: number; error: string | null }[];
  stats: { total: number; pass: number; block: number; error: number; unjudged: number };
  promptHash: string;
  connected: boolean;
};

/**
 * Shared by the server-rendered TopBar and the polled status route so both
 * always report the same thing.
 */
export async function readStatus(): Promise<StatusPayload> {
  // Reap on the read path so the UI never spins for a run that died hours ago.
  reapStaleRuns();

  const prompt = getActivePrompt();
  const run = latestRun();
  return {
    run: run
      ? {
          id: run.id,
          status: run.status,
          phase: run.phase,
          progress: run.progress ? safeParse(run.progress) : null,
          error: run.error,
          started_at: run.started_at,
        }
      : null,
    sources: run
      ? sourceRuns(run.id).map((s) => ({
          source: s.source,
          status: s.status,
          items_found: s.items_found,
          items_new: s.items_new,
          error: s.error,
        }))
      : [],
    stats: videoStats(prompt.hash),
    promptHash: prompt.hash,
    connected: Boolean(getTokens()),
  };
}

function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

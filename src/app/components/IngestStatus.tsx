"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Status = {
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
};

const POLL_MS = 1500;

export function IngestStatus({ initial }: { initial: Status }) {
  const [status, setStatus] = useState(initial);
  const router = useRouter();
  const wasRunning = useRef(initial.run?.status === "running");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch("/api/ingest/status", { cache: "no-store" });
        if (!res.ok) return;
        const next: Status = await res.json();
        if (cancelled) return;
        setStatus(next);

        // The run just finished: pull the new feed in.
        if (wasRunning.current && next.run?.status !== "running") {
          wasRunning.current = false;
          router.refresh();
        }
        if (next.run?.status === "running") wasRunning.current = true;
      } catch {
        /* a failed poll is not worth surfacing; the next one will tell us */
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    }

    timer = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [router]);

  const run = status.run;
  if (!run) return <span className="text-sm text-muted">never run</span>;

  const running = run.status === "running";
  const p = run.progress;
  const pct = p?.total ? Math.round(((p.done ?? 0) / p.total) * 100) : null;
  const failed = status.sources.filter((s) => s.status === "failed");

  return (
    <div className="flex flex-col items-end gap-0.5 text-sm">
      <div className="flex items-center gap-2">
        {running && (
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
        )}
        <span className={running ? "" : "text-muted"}>
          {running
            ? p?.message ?? run.phase ?? "working"
            : `${status.stats.pass} shown · ${status.stats.block} hidden`}
          {running && pct != null ? ` (${pct}%)` : ""}
        </span>
      </div>
      {!running && status.stats.unjudged > 0 && (
        <span className="text-xs text-muted">{status.stats.unjudged} waiting to be judged</span>
      )}
      {!running && failed.length > 0 && (
        <span className="max-w-xs truncate text-xs text-accent" title={failed.map((f) => `${f.source}: ${f.error}`).join("\n")}>
          {failed.length === 1 ? `${failed[0].source} failed` : `${failed.length} sources failed`}
        </span>
      )}
    </div>
  );
}

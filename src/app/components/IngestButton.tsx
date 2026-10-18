"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function IngestButton() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function start() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/ingest", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) setNote("already running");
      else if (!res.ok) setNote(body.error ?? `failed (${res.status})`);
      else startTransition(() => router.refresh());
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {note && <span className="text-xs text-accent">{note}</span>}
      <button
        onClick={start}
        disabled={busy}
        className="rounded-full border border-edge bg-surface px-4 py-1.5 text-sm font-medium
                   transition-colors hover:bg-surface-hover disabled:opacity-50"
      >
        {busy ? "starting…" : "Refresh feed"}
      </button>
    </div>
  );
}

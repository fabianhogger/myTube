import Link from "next/link";

/**
 * "Never ingested", "not signed in" and "everything was filtered out" are three
 * very different situations and must not all render as a blank page.
 */
export type EmptyKind = "never_ingested" | "not_connected" | "all_filtered" | "unjudged";

const COPY: Record<EmptyKind, { title: string; body: React.ReactNode }> = {
  never_ingested: {
    title: "Nothing ingested yet",
    body: (
      <>
        Hit <strong>Refresh feed</strong> above to pull your subscriptions and let the filter run.
        First run takes a couple of minutes.
      </>
    ),
  },
  not_connected: {
    title: "Connect your YouTube account",
    body: (
      <>
        MyTube needs read access to your subscription list. Run{" "}
        <code className="rounded bg-surface px-1.5 py-0.5">npm run oauth:login</code>, or{" "}
        <Link href="/api/auth/google" className="text-accent underline">
          connect it here
        </Link>
        . For the algorithmic feed, also run{" "}
        <code className="rounded bg-surface px-1.5 py-0.5">npm run yt:login</code> once.
      </>
    ),
  },
  all_filtered: {
    title: "Your filter hid everything",
    body: (
      <>
        Every video in the database was blocked by the current prompt. Loosen{" "}
        <code className="rounded bg-surface px-1.5 py-0.5">filter-prompt.md</code> and run{" "}
        <code className="rounded bg-surface px-1.5 py-0.5">npm run filter</code>, or see why with{" "}
        <code className="rounded bg-surface px-1.5 py-0.5">npm run verdicts -- --blocked</code>.
      </>
    ),
  },
  unjudged: {
    title: "Videos are waiting to be judged",
    body: (
      <>
        The feed has videos but no verdicts for the current prompt yet. Run{" "}
        <code className="rounded bg-surface px-1.5 py-0.5">npm run filter</code> to judge them.
      </>
    ),
  },
};

export function EmptyState({ kind }: { kind: EmptyKind }) {
  const { title, body } = COPY[kind];
  return (
    <div className="mx-auto max-w-xl px-6 py-24 text-center">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">{body}</p>
    </div>
  );
}

import { EmptyState, type EmptyKind } from "./components/EmptyState";
import { VideoGrid } from "./components/VideoGrid";
import { getActivePrompt } from "@/lib/prompt";
import { feed, videoStats } from "@/lib/repo/videos";
import { getTokens } from "@/lib/repo/tokens";
import { latestRun } from "@/lib/repo/runs";

// Reads live SQLite on every request; there is nothing to prerender.
export const dynamic = "force-dynamic";

export default async function Home() {
  const prompt = getActivePrompt();
  const videos = feed(prompt.hash);

  if (videos.length > 0) return <VideoGrid videos={videos} />;

  // Distinguish the four reasons the grid can be empty.
  const stats = videoStats(prompt.hash);
  let kind: EmptyKind;
  if (stats.total === 0) {
    kind = !getTokens() && !latestRun() ? "not_connected" : "never_ingested";
  } else if (stats.unjudged > 0 && stats.pass === 0 && stats.block === 0) {
    kind = "unjudged";
  } else {
    kind = "all_filtered";
  }
  return <EmptyState kind={kind} />;
}

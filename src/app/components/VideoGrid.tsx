import type { VideoRow } from "@/lib/types";
import { FeedContextMenu } from "./FeedContextMenu";
import { VideoCard } from "./VideoCard";

export function VideoGrid({ videos }: { videos: VideoRow[] }) {
  return (
    <FeedContextMenu>
      <div className="grid grid-cols-1 gap-x-4 gap-y-8 px-4 py-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {videos.map((v) => (
          <VideoCard key={v.id} video={v} />
        ))}
      </div>
    </FeedContextMenu>
  );
}

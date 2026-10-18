import Link from "next/link";
import { formatDuration, formatRelativeAge, formatViewCount } from "@/lib/format";
import type { VideoRow } from "@/lib/types";

export function VideoCard({ video }: { video: VideoRow }) {
  const duration = video.is_live ? "LIVE" : formatDuration(video.duration_seconds);
  const meta = [formatViewCount(video.view_count), formatRelativeAge(video.published_at)]
    .filter(Boolean)
    .join(" · ");

  return (
    <Link href={`/watch/${video.id}`} className="group block">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-surface">
        {video.thumbnail_url ? (
          // Thumbnails come from several YouTube CDN hosts and are already sized;
          // a plain img avoids the optimizer round-trip for a local-only app.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={video.thumbnail_url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted">no thumbnail</div>
        )}
        {duration && (
          <span
            className={`absolute bottom-1.5 right-1.5 rounded px-1.5 py-0.5 text-xs font-medium text-white ${
              video.is_live ? "bg-accent" : "bg-black/80"
            }`}
          >
            {duration}
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-col gap-1">
        <h3 className="clamp-2 text-[15px] font-medium leading-snug group-hover:text-accent">
          {video.title}
        </h3>
        {video.channel_title && <p className="text-sm text-muted">{video.channel_title}</p>}
        {meta && (
          <p className="text-sm text-muted">
            {meta}
            {video.published_approx === 1 && (
              <span title="approximate date, from the scraped feed"> *</span>
            )}
          </p>
        )}
      </div>
    </Link>
  );
}

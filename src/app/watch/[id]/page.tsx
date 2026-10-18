import Link from "next/link";
import { notFound } from "next/navigation";
import { formatRelativeAge, formatViewCount } from "@/lib/format";
import { getVideo } from "@/lib/repo/videos";

export const dynamic = "force-dynamic";

export default async function Watch({ params }: PageProps<"/watch/[id]">) {
  const { id } = await params;
  const video = getVideo(id);
  if (!video) notFound();

  const meta = [formatViewCount(video.view_count), formatRelativeAge(video.published_at)]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="aspect-video w-full overflow-hidden rounded-xl bg-black">
        <iframe
          className="h-full w-full"
          src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.id)}`}
          title={video.title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>

      <h1 className="mt-4 text-xl font-semibold leading-snug">{video.title}</h1>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        {video.channel_title && <span className="font-medium text-foreground">{video.channel_title}</span>}
        {meta && <span>{meta}</span>}
        <a
          href={`https://www.youtube.com/watch?v=${video.id}`}
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-foreground"
        >
          open on YouTube
        </a>
      </div>

      {video.description && (
        <div className="mt-5 whitespace-pre-wrap rounded-xl bg-surface p-4 text-[15px] leading-relaxed">
          {video.description}
        </div>
      )}

      <Link href="/" className="mt-6 inline-block text-sm text-muted underline hover:text-foreground">
        back to feed
      </Link>
    </div>
  );
}

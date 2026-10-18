import Link from "next/link";
import { IngestButton } from "./IngestButton";
import { IngestStatus } from "./IngestStatus";
import { readStatus } from "@/lib/status";

export async function TopBar() {
  const status = await readStatus();
  return (
    <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-edge bg-background/95 px-4 py-2.5 backdrop-blur">
      <Link href="/" className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
        <span className="rounded bg-accent px-1.5 py-0.5 text-sm text-white">My</span>
        <span>Tube</span>
      </Link>
      <div className="ml-auto flex items-center gap-4">
        <IngestStatus initial={status} />
        <IngestButton />
      </div>
    </header>
  );
}

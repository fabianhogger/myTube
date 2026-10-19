"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type MenuState = { x: number; y: number; channelId: string; channelTitle: string } | null;
type Toast = { channelId: string; title: string } | null;

/**
 * One contextmenu listener for the whole grid rather than one per card: the
 * banned card vanishes on refresh, so the undo affordance has to live above it.
 * Cards opt in by carrying data-channel-id / data-channel-title.
 */
export function FeedContextMenu({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<MenuState>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-channel-id]");
    const channelId = el?.dataset.channelId;
    // No channel (e.g. a scraped video we never resolved) -> leave the browser
    // menu alone rather than offering an action that cannot work.
    if (!el || !channelId) return;
    e.preventDefault();
    setError(null);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      channelId,
      channelTitle: el.dataset.channelTitle || "this channel",
    });
  }, []);

  // Dismiss on click-away, Escape, scroll or resize.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", close, { passive: true });
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  async function setBan(channelId: string, title: string, banned: boolean) {
    setBusy(true);
    try {
      const res = await fetch("/api/channels/ban", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, banned, reason: "banned from the feed" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `failed (${res.status})`);
        return;
      }
      setMenu(null);
      setToast(banned ? { channelId, title } : null);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Keep the menu on screen near the right/bottom edges.
  const style = menu
    ? {
        left: Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 0) - 260),
        top: Math.min(menu.y, (typeof window !== "undefined" ? window.innerHeight : 0) - 120),
      }
    : undefined;

  return (
    <div onContextMenu={onContextMenu}>
      {children}

      {menu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Actions for ${menu.channelTitle}`}
          style={style}
          className="fixed z-50 w-64 overflow-hidden rounded-lg border border-edge bg-surface
                     shadow-xl shadow-black/40"
        >
          <div className="truncate border-b border-edge px-3 py-2 text-xs text-muted">
            {menu.channelTitle}
          </div>
          <button
            role="menuitem"
            disabled={busy}
            onClick={() => setBan(menu.channelId, menu.channelTitle, true)}
            className="block w-full px-3 py-2.5 text-left text-sm hover:bg-surface-hover
                       disabled:opacity-50"
          >
            {busy ? "Hiding…" : "Ban this channel"}
          </button>
          <a
            role="menuitem"
            href={`https://www.youtube.com/channel/${menu.channelId}`}
            target="_blank"
            rel="noreferrer"
            onClick={() => setMenu(null)}
            className="block px-3 py-2.5 text-left text-sm text-muted hover:bg-surface-hover"
          >
            Open channel on YouTube
          </a>
          {error && <div className="px-3 py-2 text-xs text-accent">{error}</div>}
        </div>
      )}

      {toast && (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3
                     rounded-full border border-edge bg-surface px-4 py-2.5 text-sm shadow-xl
                     shadow-black/40"
        >
          <span className="max-w-xs truncate">
            Banned <strong>{toast.title}</strong>
          </span>
          <button
            onClick={() => {
              const t = toast;
              setToast(null);
              void setBan(t.channelId, t.title, false);
            }}
            className="font-medium text-accent hover:underline"
          >
            Undo
          </button>
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="text-muted hover:text-foreground">
            ×
          </button>
        </div>
      )}
    </div>
  );
}

import { AppWindowIcon, BoxIcon, MonitorIcon } from "lucide-react";
import { useState } from "react";
import { getDomain } from "tldts";

// ---------------------------------------------------------------------------
// SourceFavicon — renders a small favicon derived from a source URL.
// Falls back to a neutral dot if the URL is missing or the image fails to load.
// ---------------------------------------------------------------------------

function domainOf(url: string): string | null {
  try {
    return getDomain(url) ?? getDomain(new URL(url).hostname) ?? null;
  } catch {
    return null;
  }
}

export function SourceFavicon({
  url,
  iconUrl,
  size = 16,
  sourceId,
  kind,
}: {
  url?: string;
  iconUrl?: string;
  size?: number;
  sourceId?: string;
  kind?: string;
}) {
  const [failed, setFailed] = useState(false);
  const domain = url ? domainOf(url) : null;
  const src =
    iconUrl ?? (domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=${size * 2}` : null);

  const RuntimeIcon =
    kind === "computer_use" || sourceId === "computer_use"
      ? MonitorIcon
      : kind === "browser_use" || sourceId === "browser_use"
        ? AppWindowIcon
        : null;

  if (RuntimeIcon) {
    return (
      <RuntimeIcon
        aria-hidden
        className="shrink-0 text-muted-foreground"
        style={{ width: size, height: size }}
      />
    );
  }

  if (!src || failed) {
    return (
      <BoxIcon
        aria-hidden
        className="shrink-0 text-muted-foreground"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="shrink-0 rounded-sm"
      style={{ width: size, height: size }}
    />
  );
}

import { useEffect, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import { Spinner } from "@executor/react/components/spinner";

import { createFilesSession } from "../web/files";

type FilesSession = {
  expiresAt: string;
  sandboxId: string;
  sandboxStatus: "created" | "reused";
  url: string;
};

export const Route = createFileRoute("/files")({
  component: FilesPage,
});

function FilesPage() {
  const requestSession = useAtomSet(createFilesSession, { mode: "promise" });
  const [error, setError] = useState<string | null>(null);
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const session = (await requestSession({})) as FilesSession;
        if (cancelled) {
          return;
        }

        setIframeUrl(session.url);
      } catch (cause) {
        if (cancelled) {
          return;
        }

        setError(cause instanceof Error ? cause.message : "Failed to load sandbox files.");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [requestSession]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="relative min-h-0 flex-1">
        {iframeUrl ? (
          <iframe className="h-full w-full border-0 bg-background" src={iframeUrl} title="Files" />
        ) : null}

        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/95">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : null}

        {!loading && error ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background px-6">
            <div className="max-w-md text-center">
              <h1 className="font-display text-2xl tracking-tight text-foreground">Files</h1>
              <p className="mt-3 text-sm text-destructive">{error}</p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

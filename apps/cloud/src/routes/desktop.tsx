import { useEffect, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useCustomer } from "autumn-js/react";
import { desktopWriteKeys } from "@executor/react/api/reactivity-keys";
import { Spinner } from "@executor/react/components/spinner";

import { createDesktopSession } from "../web/desktop";

type DesktopSession = {
  expiresAt: string;
  sandboxId: string;
  sandboxStatus: "created" | "reused";
  url: string;
};

export const Route = createFileRoute("/desktop")({
  component: DesktopPage,
});

function DesktopPage() {
  const requestSession = useAtomSet(createDesktopSession, { mode: "promise" });
  const { data: customer, isLoading: customerLoading } = useCustomer();
  const [error, setError] = useState<string | null>(null);
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const hasProAccess =
    customer?.subscriptions?.some(
      (subscription) =>
        subscription.planId === "pro" &&
        (subscription.status === "active" ||
          subscription.status === "trialing" ||
          subscription.status === "past_due"),
    ) ?? false;

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (customerLoading) {
        return;
      }

      if (!hasProAccess) {
        setIframeUrl(null);
        setError(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const session = (await requestSession({
          reactivityKeys: desktopWriteKeys,
        })) as DesktopSession;
        if (cancelled) {
          return;
        }

        setIframeUrl(session.url);
      } catch (cause) {
        if (cancelled) {
          return;
        }

        setError(cause instanceof Error ? cause.message : "Failed to load sandbox desktop.");
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
  }, [customerLoading, hasProAccess, requestSession]);

  if (customerLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  if (!hasProAccess) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background px-6">
        <div className="max-w-md text-center">
          <h1 className="font-display text-2xl tracking-tight text-foreground">Desktop</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Persistent desktop is only available on Pro.
          </p>
          <Link
            to="/billing/plans"
            className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            View plans
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="relative min-h-0 flex-1">
        {iframeUrl ? (
          <iframe
            className="h-full w-full border-0 bg-background"
            src={iframeUrl}
            title="Desktop"
          />
        ) : null}

        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/95">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : null}

        {!loading && error ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background px-6">
            <div className="max-w-md text-center">
              <h1 className="font-display text-2xl tracking-tight text-foreground">Desktop</h1>
              <p className="mt-3 text-sm text-destructive">{error}</p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

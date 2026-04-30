import { createFileRoute } from "@tanstack/react-router";
import { SourcesPage } from "@executor/react/pages/sources";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { createMcpSourcePlugin } from "@executor/plugin-mcp/react";
import { useEffect, useMemo, useState } from "react";
import { useLocalAuth, type CloudSource } from "../web/auth";

const mcpSourcePlugin = createMcpSourcePlugin({ allowStdio: true });
import { googleDiscoverySourcePlugin } from "@executor/plugin-google-discovery/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";
import { rawSourcePlugin } from "@executor/plugin-raw/react";
import { computerUseSourcePlugin } from "@executor/plugin-computer-use/react";
import { Button } from "@executor/react/components/button";
import { Checkbox } from "@executor/react/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor/react/components/dialog";
import { Label } from "@executor/react/components/label";

const sourcePlugins = [
  computerUseSourcePlugin,
  openApiSourcePlugin,
  mcpSourcePlugin,
  rawSourcePlugin,
  googleDiscoverySourcePlugin,
  graphqlSourcePlugin,
];

export const Route = createFileRoute("/")({
  component: SourcesRoute,
});

function SourcesRoute() {
  const {
    auth,
    listCloudSources,
    syncSourcesToCloud,
    syncSourcesToLocal,
    listImportCandidates,
    deviceId,
  } = useLocalAuth();
  const [cloudSources, setCloudSources] = useState<readonly CloudSource[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const organizationId = auth.status === "authenticated" ? (auth.organization?.id ?? "") : "";

  useEffect(() => {
    if (auth.status !== "authenticated") {
      setCloudSources([]);
      return;
    }

    let alive = true;
    const load = async () => {
      try {
        const sources = await listCloudSources();
        if (alive) setCloudSources(sources);
      } catch {
        if (alive) setCloudSources([]);
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [auth.status, organizationId, listCloudSources, refreshKey]);

  const overlaySources = useMemo(
    () => cloudSources.map((source) => ({ ...source, availability: "cloud" as const })),
    [cloudSources],
  );

  return (
    <>
      <SourcesPage
        sourcePlugins={sourcePlugins}
        baseSourceAvailability="local"
        overlaySources={overlaySources}
        linkableSourceAvailabilities={["local", "both"]}
        localDeviceAvailable
        onSyncToCloud={async (sourceId) => {
          await syncSourcesToCloud([sourceId]);
          setRefreshKey((key) => key + 1);
        }}
        onSyncToLocal={async (sourceId) => {
          await syncSourcesToLocal([sourceId]);
          setRefreshKey((key) => key + 1);
        }}
      />
      <InitialSourceSyncModal
        auth={auth}
        deviceId={deviceId}
        listImportCandidates={listImportCandidates}
        syncSourcesToCloud={syncSourcesToCloud}
        onSynced={() => setRefreshKey((key) => key + 1)}
      />
    </>
  );
}

function InitialSourceSyncModal(props: {
  auth: ReturnType<typeof useLocalAuth>["auth"];
  deviceId: string | null;
  listImportCandidates: ReturnType<typeof useLocalAuth>["listImportCandidates"];
  syncSourcesToCloud: ReturnType<typeof useLocalAuth>["syncSourcesToCloud"];
  onSynced: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<
    readonly { id: string; name: string; kind: string; pluginId: string }[]
  >([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const auth = props.auth;
  const listImportCandidates = props.listImportCandidates;
  const key =
    auth.status === "authenticated"
      ? `source-sync-prompt:${auth.user.id}:${auth.organization?.id ?? "none"}:${props.deviceId ?? "unknown"}`
      : null;

  useEffect(() => {
    if (auth.status !== "authenticated" || !key || window.localStorage.getItem(key)) {
      setOpen(false);
      return;
    }

    let alive = true;
    listImportCandidates()
      .then((sources) => {
        if (!alive) return;
        setCandidates(sources);
        setSelected(new Set(sources.map((source) => source.id)));
        setOpen(sources.length > 0);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [auth.status, key, listImportCandidates]);

  const finish = () => {
    if (key) window.localStorage.setItem(key, "1");
    setOpen(false);
  };

  const syncSelected = async () => {
    setSaving(true);
    try {
      await props.syncSourcesToCloud(Array.from(selected));
      props.onSynced();
      finish();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? finish() : setOpen(next))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bring local sources to cloud</DialogTitle>
          <DialogDescription>
            Pick the sources that should keep working when this Mac is offline.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {candidates.map((source) => (
            <Label
              key={source.id}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-3"
            >
              <Checkbox
                checked={selected.has(source.id)}
                onCheckedChange={(checked) => {
                  const next = new Set(selected);
                  if (checked) next.add(source.id);
                  else next.delete(source.id);
                  setSelected(next);
                }}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{source.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {source.id} · {source.kind}
                </span>
              </span>
            </Label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={finish} disabled={saving}>
            Not now
          </Button>
          <Button onClick={syncSelected} disabled={saving || selected.size === 0}>
            {saving ? "Syncing..." : "Bring selected to cloud"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

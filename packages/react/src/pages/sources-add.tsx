import { Suspense, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomSet } from "@effect-atom/atom-react";
import { removeSource } from "../api/atoms";
import { sourceWriteKeys } from "../api/reactivity-keys";
import { Checkbox } from "../components/checkbox";
import { Label } from "../components/label";
import { useScope } from "../hooks/use-scope";
import type { ManagedAuthAccess, SourcePlugin } from "../plugins/source-plugin";

type SourcePlacement = "local" | "cloud";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SourcesAddPage(props: {
  pluginKey: string;
  url?: string;
  preset?: string;
  namespace?: string;
  sourcePlugins: readonly SourcePlugin[];
  nativePlacement?: SourcePlacement;
  signedIn?: boolean;
  localDeviceAvailable?: boolean;
  managedAuthAccess?: ManagedAuthAccess;
  syncToCloud?: (sourceId: string) => Promise<void>;
  syncToLocal?: (sourceId: string) => Promise<void>;
}) {
  const { pluginKey, url, preset, namespace, sourcePlugins } = props;
  const navigate = useNavigate();
  const scopeId = useScope();
  const doRemove = useAtomSet(removeSource, { mode: "promise" });

  const plugin = sourcePlugins.find((p) => p.key === pluginKey);
  const nativePlacement = props.nativePlacement ?? "cloud";
  const supportsCloud = plugin?.supportsCloud === true;
  const signedIn = props.signedIn ?? nativePlacement === "cloud";
  const localDeviceAvailable = props.localDeviceAvailable ?? nativePlacement === "local";

  const initialPlacement = useMemo(() => {
    if (!supportsCloud) return { local: true, cloud: false };
    if (nativePlacement === "local") {
      return signedIn ? { local: true, cloud: true } : { local: true, cloud: false };
    }
    return { local: false, cloud: true };
  }, [nativePlacement, signedIn, supportsCloud]);
  const [placement, setPlacement] = useState(initialPlacement);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    setPlacement(initialPlacement);
  }, [initialPlacement]);

  if (!plugin) {
    return (
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
            <p className="text-sm font-medium text-foreground/70 mb-1">
              Unknown source type: {pluginKey}
            </p>
            <p className="text-xs text-muted-foreground mb-5">
              This source plugin is not registered.
            </p>
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Back to sources
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const AddComponent = plugin.add;

  const removeNativeSource = async (sourceId: string) => {
    await doRemove({
      path: { scopeId, sourceId },
      reactivityKeys: sourceWriteKeys,
    });
  };

  const completeAdd = async (sourceId?: string) => {
    if (!sourceId) {
      void navigate({ to: "/" });
      return;
    }

    setSyncError(null);
    const nativeSelected = placement[nativePlacement];
    const otherPlacement: SourcePlacement = nativePlacement === "local" ? "cloud" : "local";
    const otherSelected = placement[otherPlacement];

    try {
      if (otherSelected) {
        if (otherPlacement === "cloud") {
          await props.syncToCloud?.(sourceId);
        } else {
          await props.syncToLocal?.(sourceId);
        }
      }

      if (!nativeSelected) {
        await removeNativeSource(sourceId);
      }

      void navigate({ to: "/" });
    } catch (error) {
      if (!nativeSelected) {
        await removeNativeSource(sourceId).catch(() => undefined);
      }
      setSyncError(
        nativeSelected
          ? "Source created, but syncing the other placement failed."
          : error instanceof Error
            ? error.message
            : "Could not create source in the selected placement.",
      );
    }
  };

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-4xl flex-col px-6 py-10 lg:px-10 lg:py-14">
        {syncError && (
          <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {syncError}
          </div>
        )}
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
          <AddComponent
            initialUrl={url}
            initialPreset={preset}
            initialNamespace={namespace}
            managedAuthAccess={props.managedAuthAccess}
            placement={
              <PlacementSelector
                supportsCloud={supportsCloud}
                nativePlacement={nativePlacement}
                signedIn={signedIn}
                localDeviceAvailable={localDeviceAvailable}
                localChecked={placement.local}
                cloudChecked={placement.cloud}
                onChange={setPlacement}
              />
            }
            onComplete={(sourceId) => void completeAdd(sourceId)}
            onCancel={() => {
              void navigate({ to: "/" });
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}

function PlacementSelector(props: {
  supportsCloud: boolean;
  nativePlacement: SourcePlacement;
  signedIn: boolean;
  localDeviceAvailable: boolean;
  localChecked: boolean;
  cloudChecked: boolean;
  onChange: (placement: { local: boolean; cloud: boolean }) => void;
}) {
  const localLocked =
    !props.supportsCloud || (!props.signedIn && props.nativePlacement === "local");
  const cloudLocked = !props.supportsCloud || !props.signedIn;
  const localDisabled = !props.supportsCloud
    ? true
    : props.nativePlacement === "cloud" && !props.localDeviceAvailable;
  const cloudDisabled = !props.supportsCloud || !props.signedIn;

  const set = (key: SourcePlacement, checked: boolean) => {
    const next = {
      local: key === "local" ? checked : props.localChecked,
      cloud: key === "cloud" ? checked : props.cloudChecked,
    };
    if (!next.local && !next.cloud) next[key === "local" ? "cloud" : "local"] = true;
    props.onChange(next);
  };

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3 text-sm font-medium text-foreground">
        Save source to
      </div>
      <div className="grid gap-0 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <PlacementCheckbox
          label="Local"
          description={
            props.nativePlacement === "cloud" && !props.localDeviceAvailable
              ? "Connect the desktop app to save locally."
              : "Available when this Mac is running."
          }
          checked={props.localChecked}
          disabled={localLocked || localDisabled}
          onCheckedChange={(checked) => set("local", checked)}
        />
        <PlacementCheckbox
          label="Cloud"
          description={
            props.supportsCloud
              ? "Available even when this Mac is offline."
              : "This source only runs locally."
          }
          checked={props.cloudChecked}
          disabled={cloudLocked || cloudDisabled}
          onCheckedChange={(checked) => set("cloud", checked)}
        />
      </div>
    </section>
  );
}

function PlacementCheckbox(props: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Label
      className={
        "flex min-h-[72px] items-start gap-3 px-4 py-3 transition-colors " +
        (props.disabled ? "opacity-60" : "cursor-pointer hover:bg-muted/40")
      }
    >
      <Checkbox
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={(value) => props.onCheckedChange(value === true)}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{props.label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{props.description}</span>
      </span>
    </Label>
  );
}

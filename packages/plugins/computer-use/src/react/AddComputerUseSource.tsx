import { useState } from "react";
import {
  MonitorIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@effect-atom/atom-react";

import { Alert, AlertDescription, AlertTitle } from "@executor/react/components/alert";
import { Badge } from "@executor/react/components/badge";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import { FloatActions } from "@executor/react/components/float-actions";
import { Spinner } from "@executor/react/components/spinner";
import { usePendingSources } from "@executor/react/api/optimistic";
import { useScope } from "@executor/react/api/scope-context";
import {
  addComputerUseSource,
  computerUseStatusAtom,
  computerUseWriteKeys,
  requestComputerUseAccessibilityPermission,
  requestComputerUseScreenRecordingPermission,
} from "./atoms";

const ready = (status: { accessibility: boolean; screenRecording: boolean }) =>
  status.accessibility && status.screenRecording;

function PermissionBadge(props: {
  granted: boolean | null;
  disabled: boolean;
  onRequest: () => void;
}) {
  if (props.granted) {
    return <Badge>Granted</Badge>;
  }

  if (props.granted === null) {
    return <Badge variant="secondary">Checking</Badge>;
  }

  return (
    <Badge asChild variant="secondary">
      <button
        type="button"
        className="cursor-pointer hover:bg-secondary/80 disabled:pointer-events-none disabled:opacity-50"
        onClick={props.onRequest}
        disabled={props.disabled}
      >
        Request
      </button>
    </Badge>
  );
}

export default function AddComputerUseSource(props: {
  onComplete: () => void;
  onCancel: () => void;
}) {
  const scopeId = useScope();
  const statusAtom = computerUseStatusAtom(scopeId);
  const status = useAtomValue(statusAtom);
  const refreshStatus = useAtomRefresh(statusAtom);
  const doRequestAccessibility = useAtomSet(requestComputerUseAccessibilityPermission, {
    mode: "promise",
  });
  const doRequestScreenRecording = useAtomSet(requestComputerUseScreenRecordingPermission, {
    mode: "promise",
  });
  const doAdd = useAtomSet(addComputerUseSource, { mode: "promise" });
  const { beginAdd } = usePendingSources();

  const [requesting, setRequesting] = useState<"accessibility" | "screenRecording" | null>(null);
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestedStatus, setRequestedStatus] = useState<{
    accessibility: boolean;
    screenRecording: boolean;
  } | null>(null);

  const loadedStatus = Result.match(status, {
    onSuccess: ({ value }) => value,
    onInitial: () => null,
    onFailure: () => null,
  });
  const currentStatus = requestedStatus ?? loadedStatus;
  const canAdd = currentStatus ? ready(currentStatus) : false;

  const handleRequest = async (permission: "accessibility" | "screenRecording") => {
    setRequesting(permission);
    setError(null);
    try {
      const request =
        permission === "accessibility"
          ? doRequestAccessibility
          : doRequestScreenRecording;
      const nextStatus = await request({
        path: { scopeId },
        reactivityKeys: computerUseWriteKeys,
      });
      setRequestedStatus(nextStatus);
      refreshStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to request permissions");
    } finally {
      setRequesting(null);
    }
  };

  const handleCheck = () => {
    setChecking(true);
    setError(null);
    setRequestedStatus(null);
    refreshStatus();
    window.setTimeout(() => setChecking(false), 350);
  };

  const handleAdd = async () => {
    setAdding(true);
    setError(null);
    const placeholder = beginAdd({
      id: "computer_use",
      name: "Computer Use",
      kind: "computer_use",
    });
    try {
      await doAdd({
        path: { scopeId },
        reactivityKeys: computerUseWriteKeys,
      });
      props.onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to add Computer Use");
      setAdding(false);
    } finally {
      placeholder.done();
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
            <MonitorIcon className="size-4" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Add Computer Use</h1>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-1"
            onClick={handleCheck}
            disabled={checking || adding}
            aria-label="Refresh permissions"
            title="Refresh permissions"
          >
            {checking ? <Spinner className="size-4" /> : <RefreshCwIcon className="size-4" />}
          </Button>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Let agents inspect app windows, read visible controls, click, type, scroll, and return
          screenshots from this Mac.
        </p>
      </div>

      <Alert>
        <ShieldAlertIcon />
        <AlertTitle>macOS permission required</AlertTitle>
        <AlertDescription>
          Computer Use needs Accessibility to operate app controls and Screen Recording to capture
          window state for the agent.
        </AlertDescription>
      </Alert>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField label="Accessibility" description="inspect controls and perform actions">
            <PermissionBadge
              granted={currentStatus ? currentStatus.accessibility : null}
              disabled={requesting !== null || adding}
              onRequest={() => handleRequest("accessibility")}
            />
          </CardStackEntryField>
          <CardStackEntryField label="Screen Recording" description="capture app windows">
            <PermissionBadge
              granted={currentStatus ? currentStatus.screenRecording : null}
              disabled={requesting !== null || adding}
              onRequest={() => handleRequest("screenRecording")}
            />
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not continue</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <FloatActions>
        <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
          Cancel
        </Button>
        <Button onClick={handleAdd} disabled={!canAdd || adding}>
          {adding && <Spinner className="size-3.5" />}
          {adding ? "Adding..." : "Add source"}
        </Button>
      </FloatActions>
    </div>
  );
}

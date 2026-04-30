import { Result, useAtomRefresh, useAtomValue } from "@effect-atom/atom-react";

import { Alert, AlertDescription, AlertTitle } from "@executor/react/components/alert";
import { Badge } from "@executor/react/components/badge";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import { useScope } from "@executor/react/api/scope-context";
import { computerUseStatusAtom } from "./atoms";

const ready = (status: { accessibility: boolean; screenRecording: boolean }) =>
  status.accessibility && status.screenRecording;

export default function EditComputerUseSource() {
  const scopeId = useScope();
  const statusAtom = computerUseStatusAtom(scopeId);
  const status = useAtomValue(statusAtom);
  const refresh = useAtomRefresh(statusAtom);

  return (
    <div className="space-y-6">
      {Result.match(status, {
        onInitial: () => null,
        onFailure: () => (
          <Alert variant="destructive">
            <AlertTitle>Computer Use host unavailable</AlertTitle>
            <AlertDescription>
              Start the local desktop host, then check this source again.
            </AlertDescription>
          </Alert>
        ),
        onSuccess: ({ value }) =>
          ready(value) ? null : (
            <Alert variant="destructive">
              <AlertTitle>Permission needed</AlertTitle>
              <AlertDescription>
                Re-enable Accessibility and Screen Recording in macOS System Settings to use this
                source.
              </AlertDescription>
            </Alert>
          ),
      })}

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField label="Accessibility" description="inspect controls and perform actions">
            <Badge variant={Result.match(status, {
              onSuccess: ({ value }) => (value.accessibility ? "default" : "secondary"),
              onInitial: () => "secondary",
              onFailure: () => "secondary",
            })}>
              {Result.match(status, {
                onSuccess: ({ value }) => (value.accessibility ? "Granted" : "Needed"),
                onInitial: () => "Checking",
                onFailure: () => "Unknown",
              })}
            </Badge>
          </CardStackEntryField>
          <CardStackEntryField label="Screen Recording" description="capture app windows">
            <Badge variant={Result.match(status, {
              onSuccess: ({ value }) => (value.screenRecording ? "default" : "secondary"),
              onInitial: () => "secondary",
              onFailure: () => "secondary",
            })}>
              {Result.match(status, {
                onSuccess: ({ value }) => (value.screenRecording ? "Granted" : "Needed"),
                onInitial: () => "Checking",
                onFailure: () => "Unknown",
              })}
            </Badge>
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      <Button variant="outline" onClick={() => refresh()}>
        Check permissions
      </Button>
    </div>
  );
}

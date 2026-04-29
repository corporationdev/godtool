import type { ScopeId } from "@executor/sdk";
import { ReactivityKey, sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { ComputerUseClient } from "./client";

export const computerUseStatusAtom = (scopeId: ScopeId) =>
  ComputerUseClient.query("computerUse", "status", {
    path: { scopeId },
    timeToLive: "5 seconds",
    reactivityKeys: [ReactivityKey.sources],
  });

export const requestComputerUseAccessibilityPermission = ComputerUseClient.mutation(
  "computerUse",
  "requestAccessibilityPermission",
);

export const requestComputerUseScreenRecordingPermission = ComputerUseClient.mutation(
  "computerUse",
  "requestScreenRecordingPermission",
);

export const addComputerUseSource = ComputerUseClient.mutation("computerUse", "addSource");

export const computerUseWriteKeys = sourceWriteKeys;

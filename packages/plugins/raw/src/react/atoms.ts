import type { ScopeId } from "@executor/sdk";
import { ReactivityKey } from "@executor/react/api/reactivity-keys";

import { RawClient } from "./client";

export const rawSourceAtom = (scopeId: ScopeId, namespace: string) =>
  RawClient.query("raw", "getSource", {
    path: { scopeId, namespace },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.sources, ReactivityKey.tools],
  });

export const addRawSource = RawClient.mutation("raw", "addSource");

export const updateRawSource = RawClient.mutation("raw", "updateSource");

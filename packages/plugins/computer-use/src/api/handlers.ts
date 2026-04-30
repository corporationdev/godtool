import { HttpApiBuilder } from "@effect/platform";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor/api";
import type { ComputerUsePluginExtension } from "../index";
import { ComputerUseGroup } from "./group";

export class ComputerUseExtensionService extends Context.Tag("ComputerUseExtensionService")<
  ComputerUseExtensionService,
  ComputerUsePluginExtension
>() {}

const ExecutorApiWithComputerUse = addGroup(ComputerUseGroup);

export const ComputerUseHandlers = HttpApiBuilder.group(
  ExecutorApiWithComputerUse,
  "computerUse",
  (handlers) =>
    handlers
      .handle("status", () =>
        capture(Effect.gen(function* () {
          const ext = yield* ComputerUseExtensionService;
          return yield* ext.status();
        })),
      )
      .handle("requestAccessibilityPermission", () =>
        capture(Effect.gen(function* () {
          const ext = yield* ComputerUseExtensionService;
          return yield* ext.requestAccessibilityPermission();
        })),
      )
      .handle("requestScreenRecordingPermission", () =>
        capture(Effect.gen(function* () {
          const ext = yield* ComputerUseExtensionService;
          return yield* ext.requestScreenRecordingPermission();
        })),
      )
      .handle("addSource", ({ path }) =>
        capture(Effect.gen(function* () {
          const ext = yield* ComputerUseExtensionService;
          return yield* ext.addSource({ scope: path.scopeId });
        })),
      ),
);

import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { addGroup, capture } from "@executor/api";

import { AuthContext } from "../auth/middleware";
import { DbService } from "../services/db";
import { makeSandboxesService } from "../services/sandboxes";
import { DesktopApi } from "./api";

const ExecutorApiWithDesktop = addGroup(DesktopApi);

export const DesktopHandlers = HttpApiBuilder.group(ExecutorApiWithDesktop, "desktop", (handlers) =>
  handlers.handle("createSession", () =>
    capture(
      Effect.gen(function* () {
        const auth = yield* AuthContext;
        const { db } = yield* DbService;
        return yield* Effect.promise(() =>
          makeSandboxesService(db).ensureDesktopSession(auth.organizationId),
        );
      }),
    ),
  ),
);

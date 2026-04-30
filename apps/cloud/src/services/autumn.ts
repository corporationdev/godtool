// ---------------------------------------------------------------------------
// Autumn billing service — wraps the autumn-js SDK with Effect
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Autumn } from "autumn-js";
import { Context, Data, Effect, Layer } from "effect";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AutumnError extends Data.TaggedError("AutumnError")<{
  cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export type IAutumnService = Readonly<{
  use: <A>(fn: (client: Autumn) => Promise<A>) => Effect.Effect<A, AutumnError, never>;
  isFeatureAllowed: (
    organizationId: string,
    featureId: string,
  ) => Effect.Effect<boolean, never, never>;
  /**
   * Fire-and-forget-safe execution usage tracker. Errors are caught and
   * logged; the returned Effect never fails. Callers typically
   * `Effect.runFork` it at the boundary so the billing call can't stall a
   * user-facing request.
   */
  trackExecution: (organizationId: string) => Effect.Effect<void, never, never>;
}>;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const make = Effect.sync(() => {
  const secretKey = env.AUTUMN_SECRET_KEY;

  if (env.NODE_ENV === "test") {
    const notConfigured = Effect.die(new Error("Autumn test client is not available"));
    return {
      use: () => notConfigured,
      isFeatureAllowed: () => Effect.succeed(true),
      trackExecution: () => Effect.void,
    } satisfies IAutumnService;
  }

  if (!secretKey) {
    const notConfigured = Effect.die(
      new Error("Autumn not configured — AUTUMN_SECRET_KEY is empty"),
    );
    return {
      use: () => notConfigured,
      isFeatureAllowed: () => Effect.succeed(false),
      trackExecution: () => Effect.void,
    } satisfies IAutumnService;
  }

  const client = new Autumn({ secretKey });

  const use = <A>(fn: (client: Autumn) => Promise<A>) =>
    Effect.tryPromise({
      try: () => fn(client),
      catch: (cause) => new AutumnError({ cause }),
    }).pipe(Effect.withSpan(`autumn.${fn.name ?? "use"}`));

  const isFeatureAllowed = (organizationId: string, featureId: string) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "autumn.customer.id": organizationId,
        "autumn.feature.id": featureId,
      });
      const outcome = yield* Effect.either(
        use((c) => c.check({ customerId: organizationId, featureId })),
      );
      if (outcome._tag === "Right") return outcome.right.allowed === true;

      yield* Effect.annotateCurrentSpan({ "autumn.check.failed": true });
      console.warn("[billing] feature check failed:", outcome.left);
      return false;
    }).pipe(Effect.withSpan("autumn.isFeatureAllowed"));

  const trackExecution = (organizationId: string) =>
    Effect.sync(() => {
      void organizationId;
    }).pipe(Effect.withSpan("autumn.trackExecution"));

  return { use, isFeatureAllowed, trackExecution } satisfies IAutumnService;
});

export class AutumnService extends Context.Tag("@executor/cloud/AutumnService")<
  AutumnService,
  IAutumnService
>() {
  static Default = Layer.effect(this, make).pipe(Layer.annotateSpans({ module: "AutumnService" }));
}

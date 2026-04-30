import { HttpApi, HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Duration, Effect } from "effect";
import { setCookie, deleteCookie } from "@tanstack/react-start/server";
import { resolveRuntimeContext } from "@executor/config/runtime";

import { AUTH_PATHS, CloudAuthApi, CloudAuthPublicApi } from "./api";
import { SessionContext } from "./middleware";
import { UserStoreService } from "./context";
import { authorizeOrganization } from "./authorize-organization";
import { env } from "cloudflare:workers";
import { WorkOSError } from "./errors";
import { WorkOSAuth } from "./workos";

const COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 24 * 7,
  secure: true,
};

const RESPONSE_COOKIE_OPTIONS = {
  ...COOKIE_OPTIONS,
  maxAge: Duration.days(7),
};

const getRuntimeAppOrigin = (): string => {
  const stage = env.STAGE;
  if (!stage) {
    return env.VITE_PUBLIC_SITE_URL ?? "";
  }

  return resolveRuntimeContext(stage).appUrl;
};

const setResponseCookie = (
  response: HttpServerResponse.HttpServerResponse,
  name: string,
  value: string,
  options: typeof RESPONSE_COOKIE_OPTIONS,
) => HttpServerResponse.unsafeSetCookie(response, name, value, options);

const DESKTOP_STATE_PREFIX = "desktop:";

const encodeDesktopState = (state: string): string => `${DESKTOP_STATE_PREFIX}${state}`;

const decodeDesktopState = (state: string | undefined): string | null => {
  if (!state?.startsWith(DESKTOP_STATE_PREFIX)) return null;
  const value = state.slice(DESKTOP_STATE_PREFIX.length);
  return value.length > 0 ? value : null;
};

// ---------------------------------------------------------------------------
// Single non-protected API surface — public (login/callback) + session
// (me/logout/organizations/switch-organization). The session group has SessionAuth on it.
// ---------------------------------------------------------------------------

export const NonProtectedApi = HttpApi.make("cloudWeb").add(CloudAuthPublicApi).add(CloudAuthApi);

// ---------------------------------------------------------------------------
// Public auth handlers (no authentication required)
// ---------------------------------------------------------------------------

export const CloudAuthPublicHandlers = HttpApiBuilder.group(
  NonProtectedApi,
  "cloudAuthPublic",
  (handlers) =>
    handlers
      .handleRaw("login", ({ urlParams }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const origin = getRuntimeAppOrigin();
          const state =
            urlParams.desktop === "1" && urlParams.desktop_state
              ? encodeDesktopState(urlParams.desktop_state)
              : undefined;
          const url = workos.getAuthorizationUrl(`${origin}${AUTH_PATHS.callback}`, state);
          return HttpServerResponse.redirect(url, { status: 302 });
        }),
      )
      .handleRaw("callback", ({ urlParams }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const users = yield* UserStoreService;

          const result = yield* workos.authenticateWithCode(urlParams.code);

          // Mirror the account locally
          yield* users.use((s) => s.ensureAccount(result.user.id));

          let sealedSession = result.sealedSession;

          // If the auth response didn't surface an org but the user already
          // belongs to one, rehydrate the session with it. If they have no
          // memberships at all, leave the session org-less — the frontend
          // AuthGate will render the onboarding flow. We never auto-create
          // organizations on login.
          if (!result.organizationId && sealedSession) {
            const memberships = yield* workos.listUserMemberships(result.user.id);
            const existing = memberships.data[0];
            if (existing) {
              const refreshed = yield* workos.refreshSession(
                sealedSession,
                existing.organizationId,
              );
              if (refreshed) sealedSession = refreshed;
            }
          }

          if (!sealedSession) {
            return HttpServerResponse.text("Failed to create session", { status: 500 });
          }

          const desktopState = decodeDesktopState(urlParams.state);
          if (desktopState) {
            const callback = new URL("http://127.0.0.1:14791/auth/callback");
            callback.searchParams.set("session", sealedSession);
            callback.searchParams.set("state", desktopState);
            return setResponseCookie(
              HttpServerResponse.redirect(callback.toString(), { status: 302 }),
              "wos-session",
              sealedSession,
              RESPONSE_COOKIE_OPTIONS,
            );
          }

          return setResponseCookie(
            HttpServerResponse.redirect("/", { status: 302 }),
            "wos-session",
            sealedSession,
            RESPONSE_COOKIE_OPTIONS,
          );
        }),
      ),
);

// ---------------------------------------------------------------------------
// Session auth handlers (require session, may or may not have an org)
// ---------------------------------------------------------------------------

export const CloudSessionAuthHandlers = HttpApiBuilder.group(
  NonProtectedApi,
  "cloudAuth",
  (handlers) =>
    handlers
      .handle("me", () =>
        Effect.gen(function* () {
          const session = yield* SessionContext;
          const org = session.organizationId
            ? yield* authorizeOrganization(session.accountId, session.organizationId)
            : null;

          return {
            user: {
              id: session.accountId,
              email: session.email,
              name: session.name,
              avatarUrl: session.avatarUrl,
            },
            organization: org ? { id: org.id, name: org.name } : null,
          };
        }),
      )
      .handleRaw("logout", () => {
        deleteCookie("wos-session", { path: "/" });
        return Effect.succeed(HttpServerResponse.redirect("/", { status: 302 }));
      })
      .handle("organizations", () =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const session = yield* SessionContext;

          const memberships = yield* workos.listUserMemberships(session.accountId);
          const organizations = yield* Effect.all(
            memberships.data.map((m) =>
              workos.getOrganization(m.organizationId).pipe(
                Effect.map((org) => ({ id: org.id, name: org.name })),
                Effect.orElseSucceed(() => null),
              ),
            ),
            { concurrency: "unbounded" },
          );

          return {
            organizations: organizations.filter(
              (org): org is NonNullable<typeof org> => org !== null,
            ),
            activeOrganizationId: session.organizationId,
          };
        }),
      )
      .handle("switchOrganization", ({ payload }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const session = yield* SessionContext;

          const refreshed = yield* workos.refreshSession(
            session.sealedSession,
            payload.organizationId,
          );
          if (refreshed) {
            setCookie("wos-session", refreshed, COOKIE_OPTIONS);
          }
        }),
      )
      .handle("createOrganization", ({ payload }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const users = yield* UserStoreService;
          const session = yield* SessionContext;

          const name = payload.name.trim();
          const org = yield* workos.createOrganization(name);
          yield* workos.createMembership(org.id, session.accountId, "admin");
          yield* users.use((s) => s.upsertOrganization({ id: org.id, name: org.name }));

          // Try to attach the new org to the current session. This can fail
          // (or silently return a session still scoped to the old org) when
          // the caller's current session is stale — most commonly after the
          // user was removed from the org their cookie is pinned to. In that
          // case we can't repair the session in-place, so we clear the
          // cookie and fail loudly; the frontend will bounce to login and
          // the callback's rehydrate path will pick up the new membership.
          const refreshed = yield* workos.refreshSession(session.sealedSession, org.id);
          const verified = refreshed ? yield* workos.authenticateSealedSession(refreshed) : null;

          if (!refreshed || !verified || verified.organizationId !== org.id) {
            yield* Effect.logWarning(
              "createOrganization: unable to attach new org to current session",
              {
                userId: session.accountId,
                newOrgId: org.id,
                refreshReturnedSession: refreshed != null,
                verifiedOrgId: verified?.organizationId ?? null,
              },
            );
            deleteCookie("wos-session", { path: "/" });
            return yield* new WorkOSError();
          }

          setCookie("wos-session", refreshed, COOKIE_OPTIONS);
          return { id: org.id, name: org.name };
        }),
      ),
);

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

const ensureDesktopSession = vi.fn(async (organizationId: string) => ({
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  sandboxId: `sandbox_${organizationId}`,
  sandboxStatus: ensureDesktopSession.mock.calls.length === 1 ? "created" : "reused",
  url: `https://preview.example.com/vnc.html?org=${organizationId}&token=${ensureDesktopSession.mock.calls.length}`,
}));

vi.mock("./sandboxes", () => ({
  makeSandboxesService: () => ({
    ensureDesktopSession,
  }),
}));

const { asOrg } = await import("./__test-harness__/api-harness");

describe("desktop api (HTTP)", () => {
  it.effect("returns a desktop session for the authenticated org", () =>
    Effect.gen(function* () {
      ensureDesktopSession.mockClear();
      const org = `org_${crypto.randomUUID()}`;

      const session = yield* asOrg(org, (client) => client.desktop.createSession());

      expect(session.sandboxId.length).toBeGreaterThan(0);
      expect(session.sandboxStatus === "created" || session.sandboxStatus === "reused").toBe(true);
      expect(session.url).toContain("/vnc.html");
      expect(session.expiresAt.length).toBeGreaterThan(0);
    }),
  );

  it.effect("reuses the sandbox across repeated desktop session requests", () =>
    Effect.gen(function* () {
      ensureDesktopSession.mockClear();
      const org = `org_${crypto.randomUUID()}`;

      const first = yield* asOrg(org, (client) => client.desktop.createSession());
      const second = yield* asOrg(org, (client) => client.desktop.createSession());

      expect(first.sandboxId).toBe(second.sandboxId);
      expect(second.sandboxStatus).toBe("reused");
      expect(first.url).not.toBe(second.url);
    }),
  );
});

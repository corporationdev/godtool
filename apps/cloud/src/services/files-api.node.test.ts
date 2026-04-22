import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

const ensureCodeServerSession = vi.fn(async (organizationId: string) => ({
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  sandboxId: `sandbox_${organizationId}`,
  sandboxStatus: ensureCodeServerSession.mock.calls.length === 1 ? "created" : "reused",
  url: `https://preview.example.com/${organizationId}?token=${ensureCodeServerSession.mock.calls.length}`,
}));

vi.mock("./sandboxes", () => ({
  makeSandboxesService: () => ({
    ensureCodeServerSession,
  }),
}));

const { asOrg } = await import("./__test-harness__/api-harness");

describe("files api (HTTP)", () => {
  it.effect("returns a files session for the authenticated org", () =>
    Effect.gen(function* () {
      ensureCodeServerSession.mockClear();
      const org = `org_${crypto.randomUUID()}`;

      const session = yield* asOrg(org, (client) => client.files.createSession());

      expect(session.sandboxId.length).toBeGreaterThan(0);
      expect(session.sandboxStatus === "created" || session.sandboxStatus === "reused").toBe(true);
      expect(session.url.length).toBeGreaterThan(0);
      expect(session.expiresAt.length).toBeGreaterThan(0);
    }),
  );

  it.effect("reuses the sandbox across repeated files session requests", () =>
    Effect.gen(function* () {
      ensureCodeServerSession.mockClear();
      const org = `org_${crypto.randomUUID()}`;

      const first = yield* asOrg(org, (client) => client.files.createSession());
      const second = yield* asOrg(org, (client) => client.files.createSession());

      expect(first.sandboxId).toBe(second.sandboxId);
      expect(second.sandboxStatus).toBe("reused");
      expect(first.url).not.toBe(second.url);
    }),
  );
});

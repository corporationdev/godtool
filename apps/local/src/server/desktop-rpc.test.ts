import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeDesktopRpcHandler } from "./main";

const makeEngine = () => {
  const executeWithPause = vi.fn((code: string) =>
    Effect.succeed({
      status: "completed" as const,
      result: { code },
    }),
  );
  return { executeWithPause };
};

describe("desktop RPC handler", () => {
  it("rejects execute requests without the desktop secret before running code", async () => {
    const engine = makeEngine();
    const handler = makeDesktopRpcHandler(engine as never, "secret");

    const response = await handler(
      new Request("http://127.0.0.1/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "return 1" }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(engine.executeWithPause).not.toHaveBeenCalled();
  });

  it("executes when the desktop secret matches", async () => {
    const engine = makeEngine();
    const handler = makeDesktopRpcHandler(engine as never, "secret");

    const response = await handler(
      new Request("http://127.0.0.1/execute", {
        method: "POST",
        headers: { "content-type": "application/json", "x-desktop-secret": "secret" },
        body: JSON.stringify({ code: "return 1" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "completed",
      result: { code: "return 1" },
    });
    expect(engine.executeWithPause).toHaveBeenCalledWith("return 1", {
      callerId: "desktop-rpc",
    });
  });
});

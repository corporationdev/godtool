import { describe, expect, it } from "@effect/vitest";

import {
  getStageAppUrl,
  getStageServerHostname,
  getStageServerUrl,
  resolveRuntimeContext,
} from "./runtime";

describe("runtime stage urls", () => {
  it("keeps the app url local for dev stages", () => {
    expect(getStageAppUrl("dev-isaac-1234abcd")).toBe("http://localhost:3001");
  });

  it("derives a deterministic public server url for dev stages", () => {
    expect(getStageServerHostname("dev-isaac-1234abcd")).toBe(
      "server-dev-isaac-1234abcd.godtool.dev",
    );
    expect(getStageServerUrl("dev-isaac-1234abcd")).toBe(
      "https://server-dev-isaac-1234abcd.godtool.dev",
    );
  });

  it("reuses the app hostname for production server urls", () => {
    expect(getStageServerUrl("production")).toBe("https://app.godtool.dev");
  });

  it("includes both app and server urls in the runtime context", () => {
    const runtime = resolveRuntimeContext("dev-isaac-1234abcd");

    expect(runtime.appUrl).toBe("http://localhost:3001");
    expect(runtime.serverUrl).toBe("https://server-dev-isaac-1234abcd.godtool.dev");
  });
});

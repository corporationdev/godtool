import { describe, expect, it } from "@effect/vitest";

import {
  getStageAppUrl,
  getStageAuthkitDomain,
  getStageCloudWorkerName,
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
      "server-dev-isaac-1234abcd.executor.sh",
    );
    expect(getStageServerUrl("dev-isaac-1234abcd")).toBe(
      "https://server-dev-isaac-1234abcd.executor.sh",
    );
  });

  it("reuses the app hostname for production server urls", () => {
    expect(getStageServerUrl("production")).toBe("https://executor.sh");
  });

  it("derives the deployed cloud worker name from the stage", () => {
    expect(getStageCloudWorkerName("dev-isaac-1234abcd")).toBe(
      "executor-cloud-dev-isaac-1234abcd",
    );
    expect(getStageCloudWorkerName("preview-code-server")).toBe(
      "executor-cloud-preview-code-server",
    );
    expect(getStageCloudWorkerName("production")).toBe("executor-cloud-production");
  });

  it("uses staging authkit for dev and preview, and prod authkit for production", () => {
    expect(getStageAuthkitDomain("dev-isaac-1234abcd")).toBe(
      "https://signin-staging.executor.sh",
    );
    expect(getStageAuthkitDomain("preview-my-branch")).toBe(
      "https://signin-staging.executor.sh",
    );
    expect(getStageAuthkitDomain("production")).toBe("https://signin.executor.sh");
  });

  it("includes both app and server urls in the runtime context", () => {
    const runtime = resolveRuntimeContext("dev-isaac-1234abcd");

    expect(runtime.appUrl).toBe("http://localhost:3001");
    expect(runtime.serverUrl).toBe("https://server-dev-isaac-1234abcd.executor.sh");
    expect(runtime.cloudWorkerName).toBe("executor-cloud-dev-isaac-1234abcd");
    expect(runtime.authkitDomain).toBe("https://signin-staging.executor.sh");
  });
});

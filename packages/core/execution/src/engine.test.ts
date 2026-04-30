import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatExecuteResult } from "./engine";

const PNG_BASE64 = "iVBORw0KGgo=";
let artifactsDir: string;

beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), "executor-artifacts-"));
  process.env.GODTOOL_ARTIFACTS_DIR = artifactsDir;
});

afterEach(() => {
  delete process.env.GODTOOL_ARTIFACTS_DIR;
  rmSync(artifactsDir, { recursive: true, force: true });
});

describe("formatExecuteResult image extraction", () => {
  it("extracts a top-level image result and sanitizes structured output", () => {
    const formatted = formatExecuteResult({
      result: { data: PNG_BASE64, mimeType: "image/png" },
    });

    expect(formatted.contentImages).toHaveLength(1);
    expect(formatted.contentImages[0]).toMatchObject({ data: PNG_BASE64, mimeType: "image/png" });
    expect(formatted.contentImages[0]?.path).toMatch(new RegExp(`^${artifactsDir}/image-`));
    expect(readFileSync(formatted.contentImages[0]!.path!)).toEqual(Buffer.from(PNG_BASE64, "base64"));
    expect(formatted.structured.result).toMatchObject({
      mimeType: "image/png",
      byteLength: 8,
      contentIndex: 1,
      path: formatted.contentImages[0]?.path,
      fallback: "If the image is not visible, read this file from disk.",
    });
    expect(formatted.text).not.toContain(PNG_BASE64);
  });

  it("extracts nested image results such as computer-use screenshots", () => {
    const formatted = formatExecuteResult({
      result: {
        text: "accessibility tree",
        screenshot: { data: PNG_BASE64, mimeType: "image/png" },
      },
    });

    expect(formatted.contentImages).toHaveLength(1);
    expect(formatted.contentImages[0]).toMatchObject({ data: PNG_BASE64, mimeType: "image/png" });
    expect(formatted.structured.result).toMatchObject({
      text: "accessibility tree",
      screenshot: {
        mimeType: "image/png",
        byteLength: 8,
        contentIndex: 1,
        path: formatted.contentImages[0]?.path,
        fallback: "If the image is not visible, read this file from disk.",
      },
    });
    expect(formatted.text).toContain("accessibility tree");
    expect(formatted.text).not.toContain(PNG_BASE64);
  });

  it("does not extract non-image data objects", () => {
    const formatted = formatExecuteResult({
      result: { data: PNG_BASE64, mimeType: "application/json" },
    });

    expect(formatted.contentImages).toEqual([]);
    expect(formatted.structured.result).toEqual({
      data: PNG_BASE64,
      mimeType: "application/json",
    });
  });

  it("preserves deterministic traversal order for multiple images", () => {
    const jpegBase64 = "/9j/2w==";
    const formatted = formatExecuteResult({
      result: {
        first: { data: PNG_BASE64, mimeType: "image/png" },
        nested: [{ second: { data: jpegBase64, mimeType: "image/jpeg" } }],
      },
    });

    expect(formatted.contentImages).toHaveLength(2);
    expect(formatted.contentImages[0]).toMatchObject({ data: PNG_BASE64, mimeType: "image/png" });
    expect(formatted.contentImages[1]).toMatchObject({ data: jpegBase64, mimeType: "image/jpeg" });
    expect(formatted.contentImages[0]?.path).toContain("/image-");
    expect(formatted.contentImages[1]?.path).toContain("/image-");
    expect(formatted.structured.result).toMatchObject({
      first: {
        mimeType: "image/png",
        byteLength: 8,
        contentIndex: 1,
        path: formatted.contentImages[0]?.path,
      },
      nested: [
        {
          second: {
            mimeType: "image/jpeg",
            byteLength: 4,
            contentIndex: 2,
            path: formatted.contentImages[1]?.path,
          },
        },
      ],
    });
  });
});

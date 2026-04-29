import { describe, expect, it } from "vitest";

import { formatExecuteResult } from "./engine";

const PNG_BASE64 = "iVBORw0KGgo=";

describe("formatExecuteResult image extraction", () => {
  it("extracts a top-level image result and sanitizes structured output", () => {
    const formatted = formatExecuteResult({
      result: { data: PNG_BASE64, mimeType: "image/png" },
    });

    expect(formatted.contentImages).toEqual([
      { data: PNG_BASE64, mimeType: "image/png" },
    ]);
    expect(formatted.structured.result).toEqual({
      mimeType: "image/png",
      byteLength: 8,
      contentIndex: 1,
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

    expect(formatted.contentImages).toEqual([
      { data: PNG_BASE64, mimeType: "image/png" },
    ]);
    expect(formatted.structured.result).toEqual({
      text: "accessibility tree",
      screenshot: {
        mimeType: "image/png",
        byteLength: 8,
        contentIndex: 1,
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

    expect(formatted.contentImages).toEqual([
      { data: PNG_BASE64, mimeType: "image/png" },
      { data: jpegBase64, mimeType: "image/jpeg" },
    ]);
    expect(formatted.structured.result).toEqual({
      first: { mimeType: "image/png", byteLength: 8, contentIndex: 1 },
      nested: [{ second: { mimeType: "image/jpeg", byteLength: 4, contentIndex: 2 } }],
    });
  });
});

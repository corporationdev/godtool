import { describe, expect, it } from "vitest";

import {
  formatSandboxToolCallErrorValue,
  renderSandboxToolCallErrorMessage,
} from "./sandbox-tool-call-errors";

describe("sandbox tool-call error helpers", () => {
  it("renders tagged tool lookup failures with a readable message", () => {
    expect(
      renderSandboxToolCallErrorMessage({
        _tag: "ToolNotFoundError",
        toolId: "pokeapi.pokemon.getByName",
      }),
    ).toBe("Tool not found: pokeapi.pokemon.getByName");
  });

  it("preserves message-bearing errors", () => {
    expect(
      formatSandboxToolCallErrorValue({
        _tag: "ToolInvocationError",
        message: "HTTP request failed: connection reset",
        toolId: "restcountries.name.get",
      }),
    ).toEqual({
      message: "HTTP request failed: connection reset",
      details: {
        _tag: "ToolInvocationError",
        message: "HTTP request failed: connection reset",
        toolId: "restcountries.name.get",
      },
    });
  });

  it("falls back to JSON for non-message objects", () => {
    expect(renderSandboxToolCallErrorMessage({ toolId: "foo.bar" })).toBe(
      JSON.stringify({ toolId: "foo.bar" }),
    );
  });
});

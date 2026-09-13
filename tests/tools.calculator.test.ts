import { describe, it, expect } from "vitest";
import { calculatorTool } from "../src/tools/builtin/calculatorTool.js";

describe("calculatorTool", () => {
  it("evaluates basic arithmetic with correct precedence", async () => {
    const result = await calculatorTool.execute({ expression: "(4 + 5) * 2 / 3" }, { userId: "u1" });
    expect(result.output).toEqual({ result: 6 });
  });

  it("handles unary minus", async () => {
    const result = await calculatorTool.execute({ expression: "-5 + 10" }, { userId: "u1" });
    expect(result.output).toEqual({ result: 5 });
  });

  it("handles exponents right-associatively", async () => {
    const result = await calculatorTool.execute({ expression: "2 ^ 3 ^ 2" }, { userId: "u1" });
    expect((result.output as { result: number }).result).toBe(2 ** (3 ** 2));
  });

  it("throws on division by zero", async () => {
    await expect(calculatorTool.execute({ expression: "1 / 0" }, { userId: "u1" })).rejects.toThrow(/division by zero/i);
  });

  it("rejects invalid characters instead of using eval", async () => {
    await expect(calculatorTool.execute({ expression: "process.exit(1)" }, { userId: "u1" })).rejects.toThrow();
  });

  it("rejects malformed expressions", async () => {
    await expect(calculatorTool.execute({ expression: "(1 + 2" }, { userId: "u1" })).rejects.toThrow(/parentheses/i);
  });
});

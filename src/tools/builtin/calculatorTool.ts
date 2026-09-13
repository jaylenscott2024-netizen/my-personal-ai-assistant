import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../types.js";

const inputSchema = z.object({
  expression: z.string().describe("An arithmetic expression, e.g. '(4 + 5) * 2 / 3'"),
});

// A real, safe evaluator — no eval()/Function(). Supports + - * / % ^ ()
// and unary minus over floating point numbers. This is a genuinely working
// tool (Section 94: no fake features), just intentionally narrow in scope.
function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let num = "";
      while (i < expr.length && /[0-9.]/.test(expr[i])) num += expr[i++];
      tokens.push(num);
      continue;
    }
    if ("+-*/%^()".includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" in expression.`);
  }
  return tokens;
}

// "u-" (unary minus) is its own pseudo-operator, binding tighter than any
// binary operator (higher precedence than ^) so "-5 + 10" parses as
// "(-5) + 10" rather than "-(5 + 10)".
const PRECEDENCE: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3, "u-": 4 };
const RIGHT_ASSOCIATIVE = new Set(["^", "u-"]);

function toRPN(tokens: string[]): string[] {
  const output: string[] = [];
  const ops: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^[0-9.]+$/.test(t)) {
      output.push(t);
    } else if (t === "(") {
      ops.push(t);
    } else if (t === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") output.push(ops.pop()!);
      if (ops.pop() !== "(") throw new Error("Mismatched parentheses.");
    } else {
      // unary minus: previous token is an operator, '(' or start of expr
      const prev = tokens[i - 1];
      const isUnary = t === "-" && (prev === undefined || "+-*/%^(".includes(prev));
      const op = isUnary ? "u-" : t;
      while (
        ops.length &&
        ops[ops.length - 1] !== "(" &&
        (PRECEDENCE[ops[ops.length - 1]] > PRECEDENCE[op] ||
          (PRECEDENCE[ops[ops.length - 1]] === PRECEDENCE[op] && !RIGHT_ASSOCIATIVE.has(op)))
      ) {
        output.push(ops.pop()!);
      }
      ops.push(op);
    }
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op === "(") throw new Error("Mismatched parentheses.");
    output.push(op);
  }
  return output;
}

function evalRPN(rpn: string[]): number {
  const stack: number[] = [];
  for (const t of rpn) {
    if (/^[0-9.]+$/.test(t)) {
      stack.push(Number(t));
      continue;
    }
    if (t === "u-") {
      stack.push(-stack.pop()!);
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) throw new Error("Invalid expression.");
    switch (t) {
      case "+":
        stack.push(a + b);
        break;
      case "-":
        stack.push(a - b);
        break;
      case "*":
        stack.push(a * b);
        break;
      case "/":
        if (b === 0) throw new Error("Division by zero.");
        stack.push(a / b);
        break;
      case "%":
        stack.push(a % b);
        break;
      case "^":
        stack.push(a ** b);
        break;
      default:
        throw new Error(`Unknown operator "${t}".`);
    }
  }
  if (stack.length !== 1) throw new Error("Invalid expression.");
  return stack[0];
}

export const calculatorTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "calculator",
  description: "Evaluate an arithmetic expression involving + - * / % ^ and parentheses.",
  version: "1.0.0",
  inputSchema,
  jsonSchema: zodToJsonSchema(inputSchema, "calculator") as Record<string, unknown>,
  requiredPermissions: [],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    const result = evalRPN(toRPN(tokenize(input.expression)));
    return { output: { result } };
  },
};

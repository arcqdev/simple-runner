import type { PromptAdapter } from "../../src/cli/prompts.js";

export function scriptedPrompts(answers: Array<string | boolean | string[]>): PromptAdapter {
  const queue = [...answers];

  const next = (): string | boolean | string[] => {
    if (queue.length === 0) {
      throw new Error("Prompt queue exhausted");
    }
    return queue.shift() as string | boolean | string[];
  };

  return {
    text() {
      const value = next();
      if (typeof value !== "string") {
        throw new Error(`Expected string prompt answer, received ${typeof value}`);
      }
      return value;
    },
    confirm() {
      const value = next();
      if (typeof value !== "boolean") {
        throw new Error(`Expected boolean prompt answer, received ${typeof value}`);
      }
      return value;
    },
    select() {
      const value = next();
      if (typeof value !== "string") {
        throw new Error(`Expected string prompt answer, received ${typeof value}`);
      }
      return value;
    },
    multiselect() {
      const value = next();
      if (!Array.isArray(value)) {
        throw new Error(`Expected array prompt answer, received ${typeof value}`);
      }
      return value;
    },
  };
}

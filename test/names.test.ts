import { describe, it, expect } from "vitest";
import { randomName } from "../src/telegram/names.js";

const NAME_RE = /^[a-z]{3,8}-[a-z]{3,8}-[a-z]{3,8}$/;

describe("randomName", () => {
  it("matches the three-word format", () => {
    for (let i = 0; i < 200; i++) {
      expect(randomName()).toMatch(NAME_RE);
    }
  });

  it("produces three distinct words", () => {
    for (let i = 0; i < 200; i++) {
      const words = randomName().split("-");
      expect(words).toHaveLength(3);
      expect(new Set(words).size).toBe(3);
    }
  });

  it("two consecutive calls differ", () => {
    // With >120 words the collision probability is astronomically small.
    expect(randomName()).not.toBe(randomName());
  });
});

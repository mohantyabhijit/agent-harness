import { expect, it } from "vitest";

import { add } from "../src/add.js";

it("adds two numbers", () => {
  expect(add(2, 2)).toBe(5);
});

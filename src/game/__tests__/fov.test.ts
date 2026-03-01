import { describe, it, expect } from "vitest";
import { computeFov } from "../fov";

describe("computeFov", () => {
  it("origin is always visible", () => {
    expect(computeFov(5, 5, 8, () => false).has("5,5")).toBe(true);
  });

  it("wall blocks tiles behind it", () => {
    const walls = new Set(["6,5"]);
    const visible = computeFov(5, 5, 8, (x, z) => walls.has(`${x},${z}`));
    expect(visible.has("6,5")).toBe(true);
    expect(visible.has("7,5")).toBe(false);
  });

  it("respects radius", () => {
    const visible = computeFov(5, 5, 2, () => false);
    expect(visible.has("7,5")).toBe(true);
    expect(visible.has("8,5")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { healthTier } from "../health-tier";

describe("healthTier", () => {
  it("returns Uninjured at full health", () => {
    expect(healthTier(100, 100)).toBe("Uninjured");
  });
  it("returns Scratched above 75%", () => {
    expect(healthTier(80, 100)).toBe("Scratched");
  });
  it("returns Wounded above 50%", () => {
    expect(healthTier(60, 100)).toBe("Wounded");
  });
  it("returns Badly wounded above 25%", () => {
    expect(healthTier(30, 100)).toBe("Badly wounded");
  });
  it("returns Near death at or below 25%", () => {
    expect(healthTier(25, 100)).toBe("Near death");
    expect(healthTier(1, 100)).toBe("Near death");
  });
  it("handles boundary at exactly 75%", () => {
    expect(healthTier(75, 100)).toBe("Wounded");
  });
  it("handles boundary at exactly 50%", () => {
    expect(healthTier(50, 100)).toBe("Badly wounded");
  });
});

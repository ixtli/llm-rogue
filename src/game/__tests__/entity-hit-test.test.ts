import { describe, expect, it } from "vitest";
import { type PickTarget, pickNearest } from "../entity-hit-test";

describe("pickNearest", () => {
  const targets: PickTarget[] = [
    { id: 1, screenX: 100, screenY: 100, depth: 5 },
    { id: 2, screenX: 300, screenY: 300, depth: 10 },
    { id: 3, screenX: 102, screenY: 100, depth: 8 },
  ];

  it("returns null when no target is within radius", () => {
    expect(pickNearest(500, 500, targets, 30)).toBeNull();
  });

  it("returns the closest target to the screen point", () => {
    expect(pickNearest(100, 100, targets, 30)?.id).toBe(1);
  });

  it("picks the closer-to-camera target when screen-equidistant", () => {
    expect(pickNearest(101, 100, targets, 30)?.id).toBe(1);
  });

  it("returns null for empty target list", () => {
    expect(pickNearest(100, 100, [], 30)).toBeNull();
  });

  it("respects the hit radius", () => {
    expect(pickNearest(100, 100, targets, 1)?.id).toBe(1);
    expect(pickNearest(100, 135, targets, 30)).toBeNull();
  });
});

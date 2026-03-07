import { describe, expect, it } from "vitest";
import { findHoveredEntity, type ProjectedEntity } from "../entity-hit-test";

describe("findHoveredEntity", () => {
  const entities: ProjectedEntity[] = [
    { id: 1, screenX: 100, screenY: 100, depth: 5 },
    { id: 2, screenX: 300, screenY: 300, depth: 10 },
    { id: 3, screenX: 102, screenY: 100, depth: 8 },
  ];

  it("returns null when no entity is near the mouse", () => {
    expect(findHoveredEntity(500, 500, entities, 30)).toBeNull();
  });

  it("returns the closest entity to the mouse within radius", () => {
    expect(findHoveredEntity(100, 100, entities, 30)?.id).toBe(1);
  });

  it("picks the closer-to-camera entity when mouse equidistant", () => {
    expect(findHoveredEntity(101, 100, entities, 30)?.id).toBe(1);
  });

  it("returns null for empty entity list", () => {
    expect(findHoveredEntity(100, 100, [], 30)).toBeNull();
  });

  it("respects the hit radius", () => {
    expect(findHoveredEntity(100, 100, entities, 1)?.id).toBe(1);
    expect(findHoveredEntity(100, 135, entities, 30)).toBeNull();
  });
});

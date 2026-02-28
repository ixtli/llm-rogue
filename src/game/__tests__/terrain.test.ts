// @vitest-environment node
import { describe, expect, it } from "vitest";
import { deserializeTerrainGrid, getTerrainDef } from "../terrain";

describe("deserializeTerrainGrid", () => {
  it("deserializes a single-surface column", () => {
    const bytes = new Uint8Array(1 + 3 + 1023);
    bytes[0] = 1;
    bytes[1] = 5;
    bytes[2] = 1;
    bytes[3] = 26;
    const grid = deserializeTerrainGrid(0, 0, 0, bytes.buffer);
    expect(grid.columns[0]).toEqual([{ y: 5, terrainId: 1, headroom: 26 }]);
    expect(grid.columns[1]).toEqual([]);
  });

  it("deserializes a bridge column with two surfaces", () => {
    const bytes = new Uint8Array(1 + 6 + 1023);
    bytes[0] = 2;
    bytes[1] = 0;
    bytes[2] = 1;
    bytes[3] = 9;
    bytes[4] = 10;
    bytes[5] = 3;
    bytes[6] = 21;
    const grid = deserializeTerrainGrid(1, 0, 2, bytes.buffer);
    expect(grid.columns[0]).toHaveLength(2);
    expect(grid.columns[0][0].y).toBe(0);
    expect(grid.columns[0][1].y).toBe(10);
  });
});

describe("getTerrainDef", () => {
  it("returns grass terrain", () => {
    const def = getTerrainDef(1);
    expect(def).toBeDefined();
    expect(def?.name).toBe("grass");
    expect(def?.walkable).toBe(true);
  });

  it("returns undefined for unknown terrain", () => {
    expect(getTerrainDef(99)).toBeUndefined();
  });

  it("air is not walkable", () => {
    expect(getTerrainDef(0)?.walkable).toBe(false);
  });
});

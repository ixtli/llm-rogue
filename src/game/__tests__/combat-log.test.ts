import { describe, expect, it } from "vitest";
import { formatCombatLog } from "../combat-log";

describe("formatCombatLog", () => {
  const PLAYER_ID = 1;

  it("formats player attack", () => {
    const entries = formatCombatLog(
      PLAYER_ID,
      [
        {
          damage: 12,
          crit: false,
          killed: false,
          attackerId: 1,
          defenderId: 2,
        },
      ],
      [],
      [],
      (id) => (id === 1 ? "Player" : "Goblin"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("You hit the Goblin for 12 damage.");
    expect(entries[0].color).toBe("#4ade80");
  });

  it("formats enemy attack on player", () => {
    const entries = formatCombatLog(
      PLAYER_ID,
      [
        {
          damage: 8,
          crit: false,
          killed: false,
          attackerId: 2,
          defenderId: 1,
        },
      ],
      [],
      [],
      (id) => (id === 1 ? "Player" : "Goblin"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("The Goblin hits you for 8 damage.");
    expect(entries[0].color).toBe("#f87171");
  });

  it("formats critical hit by player", () => {
    const entries = formatCombatLog(
      PLAYER_ID,
      [
        {
          damage: 24,
          crit: true,
          killed: false,
          attackerId: 1,
          defenderId: 2,
        },
      ],
      [],
      [],
      (id) => (id === 1 ? "Player" : "Goblin"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe(
      "Critical hit! You deal 24 damage to the Goblin.",
    );
    expect(entries[0].color).toBe("#facc15");
  });

  it("formats death", () => {
    const entries = formatCombatLog(
      PLAYER_ID,
      [],
      [2],
      [],
      (id) => (id === 2 ? "Goblin" : "Unknown"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("The Goblin dies.");
    expect(entries[0].color).toBe("#9ca3af");
  });

  it("formats pickup", () => {
    const entries = formatCombatLog(
      PLAYER_ID,
      [],
      [],
      ["Health Potion"],
      () => "",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("You pick up a Health Potion.");
    expect(entries[0].color).toBe("#22d3ee");
  });

  it("returns empty array when nothing happened", () => {
    const entries = formatCombatLog(PLAYER_ID, [], [], [], () => "");
    expect(entries).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import { createRunStats } from "../run-stats";

const getName = (id: number) => (id === 10 ? "Goblin" : id === 11 ? "Rat" : "unknown");

describe("RunStats", () => {
  it("starts at zero", () => {
    const stats = createRunStats();
    expect(stats.turns).toBe(0);
    expect(stats.kills).toBe(0);
    expect(stats.damageDealt).toBe(0);
    expect(stats.damageTaken).toBe(0);
    expect(stats.itemsPickedUp).toBe(0);
    expect(stats.causeOfDeath).toBeNull();
  });

  it("recordTurn increments from TurnResult", () => {
    const stats = createRunStats();
    stats.recordTurn(
      42,
      {
        resolved: true,
        npcActions: [],
        deaths: [10, 11],
        terrainEffects: [],
        combatEvents: [
          { attackerId: 42, defenderId: 10, damage: 15, killed: true, critical: false },
          { attackerId: 11, defenderId: 42, damage: 5, killed: false, critical: false },
        ],
        pickups: ["Sword", "Potion"],
        playerDead: false,
      },
      getName,
    );
    expect(stats.turns).toBe(1);
    expect(stats.kills).toBe(2);
    expect(stats.damageDealt).toBe(15);
    expect(stats.damageTaken).toBe(5);
    expect(stats.itemsPickedUp).toBe(2);
  });

  it("does not count player death as a kill", () => {
    const stats = createRunStats();
    stats.recordTurn(
      42,
      {
        resolved: true,
        npcActions: [],
        deaths: [42, 10],
        terrainEffects: [],
        combatEvents: [
          { attackerId: 10, defenderId: 42, damage: 100, killed: true, critical: false },
        ],
        pickups: [],
        playerDead: true,
      },
      getName,
    );
    expect(stats.kills).toBe(1);
  });

  it("records causeOfDeath from killing blow", () => {
    const stats = createRunStats();
    stats.recordTurn(
      42,
      {
        resolved: true,
        npcActions: [],
        deaths: [42],
        terrainEffects: [],
        combatEvents: [
          { attackerId: 10, defenderId: 42, damage: 100, killed: true, critical: false },
        ],
        pickups: [],
        playerDead: true,
      },
      getName,
    );
    expect(stats.causeOfDeath).toBe("Goblin");
  });

  it("reset clears all stats", () => {
    const stats = createRunStats();
    stats.recordTurn(
      1,
      {
        resolved: true,
        npcActions: [],
        deaths: [2],
        terrainEffects: [],
        combatEvents: [],
        pickups: ["x"],
        playerDead: false,
      },
      getName,
    );
    stats.reset();
    expect(stats.turns).toBe(0);
    expect(stats.kills).toBe(0);
    expect(stats.itemsPickedUp).toBe(0);
    expect(stats.causeOfDeath).toBeNull();
  });
});

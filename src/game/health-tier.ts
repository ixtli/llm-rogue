export type HealthTier = "Uninjured" | "Scratched" | "Wounded" | "Badly wounded" | "Near death";

export function healthTier(health: number, maxHealth: number): HealthTier {
  const ratio = health / maxHealth;
  if (ratio >= 1) return "Uninjured";
  if (ratio > 0.75) return "Scratched";
  if (ratio > 0.5) return "Wounded";
  if (ratio > 0.25) return "Badly wounded";
  return "Near death";
}

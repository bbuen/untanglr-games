import { getDatabase } from "@netlify/database";
import type { Config, Context } from "@netlify/functions";

type StatsBody = {
  fleet_damage_dealt?: unknown;
  defense_restored?: unknown;
  integrity_restored?: unknown;
};

type PlayerStats = {
  id: string | number;
  username: string;
  fleet_damage_dealt: string | number;
  defense_restored: string | number;
  integrity_restored: string | number;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function validIncrement(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export default async (req: Request, context: Context): Promise<Response> => {
  const playerId = context.params.id;
  if (!playerId || !/^\d+$/.test(playerId)) {
    return json({ error: "Player id must be a positive integer." }, 400);
  }

  let body: StatsBody;
  try {
    body = (await req.json()) as StatsBody;
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const fleetDamage = body.fleet_damage_dealt ?? 0;
  const defenseRestored = body.defense_restored ?? 0;
  const integrityRestored = body.integrity_restored ?? 0;

  if (
    !validIncrement(fleetDamage) ||
    !validIncrement(defenseRestored) ||
    !validIncrement(integrityRestored)
  ) {
    return json({ error: "Statistic increments must be non-negative integers." }, 400);
  }
  if (fleetDamage === 0 && defenseRestored === 0 && integrityRestored === 0) {
    return json({ error: "At least one statistic increment must be greater than zero." }, 400);
  }

  try {
    const database = getDatabase();
    const result = await database.pool.query<PlayerStats>(
      `UPDATE players
       SET fleet_damage_dealt = fleet_damage_dealt + $2,
           defense_restored = defense_restored + $3,
           integrity_restored = integrity_restored + $4
       WHERE id = $1
       RETURNING id, username, fleet_damage_dealt, defense_restored, integrity_restored`,
      [playerId, fleetDamage, defenseRestored, integrityRestored],
    );
    const player = result.rows[0];

    if (!player) return json({ error: "Player not found." }, 404);
    return json({ player });
  } catch (error) {
    console.error("Player statistics update failed", error);
    return json({ error: "Unable to update player statistics right now." }, 500);
  }
};

export const config: Config = {
  path: "/api/players/:id/stats",
  method: "POST",
};

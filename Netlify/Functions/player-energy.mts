import { getDatabase } from "@netlify/database";
import type { Config, Context } from "@netlify/functions";

type EnergyRow = {
  id: string | number;
  energy: number;
  last_energy_at: Date | string;
  next_energy_at: Date | string | null;
  server_time: Date | string;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export default async (_req: Request, context: Context): Promise<Response> => {
  const playerId = context.params.id;
  if (!playerId || !/^\d+$/.test(playerId)) {
    return json({ error: "Player id must be a positive integer." }, 400);
  }

  const database = getDatabase();
  const client = await database.pool.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query<EnergyRow>(
      `WITH current_player AS (
         SELECT *, GREATEST(
           0,
           FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - last_energy_at)) / 14400)::INTEGER
         ) AS regenerated
         FROM players
         WHERE id = $1
         FOR UPDATE
       ), refreshed AS (
         UPDATE players AS player
         SET energy = LEAST(5, current_player.energy + current_player.regenerated),
             last_energy_at = CASE
               WHEN current_player.energy >= 5 THEN current_player.last_energy_at
               WHEN current_player.energy + current_player.regenerated >= 5 THEN CURRENT_TIMESTAMP
               WHEN current_player.regenerated > 0
                 THEN current_player.last_energy_at + current_player.regenerated * INTERVAL '4 hours'
               ELSE current_player.last_energy_at
             END
         FROM current_player
         WHERE player.id = current_player.id
         RETURNING player.id, player.energy, player.last_energy_at
       )
       SELECT id, energy, last_energy_at,
              CASE WHEN energy < 5 THEN last_energy_at + INTERVAL '4 hours' ELSE NULL END AS next_energy_at,
              CURRENT_TIMESTAMP AS server_time
       FROM refreshed`,
      [playerId],
    );
    const player = result.rows[0];

    if (!player) {
      await client.query("ROLLBACK");
      return json({ error: "Player not found." }, 404);
    }

    await client.query("COMMIT");
    return json({
      player: {
        id: player.id,
        energy: player.energy,
        last_energy_at: player.last_energy_at,
        next_energy_at: player.next_energy_at,
      },
      server_time: player.server_time,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Energy refresh failed", error);
    return json({ error: "Unable to refresh energy right now." }, 500);
  } finally {
    client.release();
  }
};

export const config: Config = {
  path: "/api/players/:id/energy",
  method: "GET",
};

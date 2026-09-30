import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

type ActionBody = {
  playerId?: number | string;
  action?: string;
};

type PlayerRow = {
  id: number | string;
  username: string;
  class: string;
  energy: number;
  last_energy_at: Date | string;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export default async (req: Request): Promise<Response> => {
  let body: ActionBody;

  try {
    body = (await req.json()) as ActionBody;
  } catch {
    return json({ error: "Invalid JSON request body." }, 400);
  }

  const playerId = body.playerId;
  const action = String(body.action || "").toLowerCase();

  if (!playerId) {
    return json({ error: "Missing playerId." }, 400);
  }

  const validActions = ["attack", "fortify", "restore"];

  if (!validActions.includes(action)) {
    return json({ error: "Invalid war action." }, 400);
  }

  const requiredClasses: Record<string, string> = {
    attack: "Warrior",
    fortify: "Defender",
    restore: "Healer",
  };

  const requiredClass = requiredClasses[action];
  const database = getDatabase();
  const client = await database.pool.connect();

  try {
    await client.query("BEGIN");

    const playerResult = await client.query<PlayerRow>(
      `WITH current_player AS (
         SELECT *,
           GREATEST(
             0,
             FLOOR(
               EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - last_energy_at)) / 14400
             )::INTEGER
           ) AS regenerated
         FROM players
         WHERE id = $1
         FOR UPDATE
       )
       UPDATE players AS player
       SET energy = LEAST(
             5,
             current_player.energy + current_player.regenerated
           ),
           last_energy_at = CASE
             WHEN current_player.energy >= 5
               THEN current_player.last_energy_at
             WHEN current_player.energy + current_player.regenerated >= 5
               THEN CURRENT_TIMESTAMP
             WHEN current_player.regenerated > 0
               THEN current_player.last_energy_at
                    + current_player.regenerated * INTERVAL '4 hours'
             ELSE current_player.last_energy_at
           END
       FROM current_player
       WHERE player.id = current_player.id
       RETURNING player.id,
                 player.username,
                 player.class,
                 player.energy,
                 player.last_energy_at`,
      [playerId],
    );

    const player = playerResult.rows[0];

    if (!player) {
      await client.query("ROLLBACK");
      return json({ error: "Player not found." }, 404);
    }

    if (player.class !== requiredClass) {
      await client.query("ROLLBACK");
      return json(
        { error: `${requiredClass} class required for this action.` },
        403,
      );
    }

    if (Number(player.energy) <= 0) {
      await client.query("ROLLBACK");
      return json({ error: "Not enough energy." }, 409);
    }

    const existingWarResult = await client.query(
      `SELECT id
       FROM war_state
       WHERE id = 1
       FOR UPDATE`,
    );

    if (existingWarResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return json({ error: "Global war state not found." }, 404);
    }

    if (action === "attack") {
      await client.query(
        `UPDATE war_state
         SET fleet_percent = GREATEST(0, fleet_percent - 0.05),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = 1`,
      );
    } else if (action === "fortify") {
      await client.query(
        `UPDATE war_state
         SET defense = LEAST(120, defense + 0.25),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = 1`,
      );
    } else if (action === "restore") {
      await client.query(
        `UPDATE war_state
         SET integrity = LEAST(120, integrity + 0.25),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = 1`,
      );
    }

    const updatedPlayerResult = await client.query<PlayerRow>(
      `UPDATE players
       SET energy = energy - 1,
           last_energy_at = CASE
             WHEN energy >= 5 THEN CURRENT_TIMESTAMP
             ELSE last_energy_at
           END
       WHERE id = $1
       RETURNING id,
                 username,
                 class,
                 energy,
                 last_energy_at`,
      [playerId],
    );

    const updatedWarResult = await client.query(
      `SELECT day,
              fleet_percent,
              defense,
              integrity,
              next_cycle_at,
              updated_at
       FROM war_state
       WHERE id = 1`,
    );

    await client.query("COMMIT");

    const updatedPlayer = updatedPlayerResult.rows[0];
    const updatedWar = updatedWarResult.rows[0];

    return json({
      success: true,
      action,
      player: {
        id: updatedPlayer.id,
        username: updatedPlayer.username,
        class: updatedPlayer.class,
        energy: Number(updatedPlayer.energy),
        last_energy_at: updatedPlayer.last_energy_at,
      },
      war: {
        day: Number(updatedWar.day),
        fleetPercent: Number(updatedWar.fleet_percent),
        defense: Number(updatedWar.defense),
        integrity: Number(updatedWar.integrity),
        nextCycleAt: updatedWar.next_cycle_at,
        updatedAt: updatedWar.updated_at,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Global war action failed", error);

    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to complete war action.",
      },
      500,
    );
  } finally {
    client.release();
  }
};

export const config: Config = {
  path: "/api/war/action",
  method: "POST",
};

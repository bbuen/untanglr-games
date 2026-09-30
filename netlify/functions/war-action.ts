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
    body = await req.json();
  } catch {
    return json(
      { error: "Invalid JSON request body." },
      400
    );
  }

  const playerId = body.playerId;
  const action = String(body.action || "").toLowerCase();

  if (!playerId) {
    return json(
      { error: "Missing playerId." },
      400
    );
  }

  const validActions = [
    "attack",
    "fortify",
    "restore",
  ];

  if (!validActions.includes(action)) {
    return json(
      { error: "Invalid war action." },
      400
    );
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

    /*
      Refresh energy and lock the player row.
      Energy regenerates once every four hours.
    */
    const playerResult = await c*ient.query<PlayerRow>(
      `
   *  WITH current_player AS (
       *SELECT
          *,
          GREA*EST(
            0,
            FL*OR(
              EXTRACT(
       *        EPOCH FROM (
             *    CURRENT_TIMESTAMP - last_energ*_at
                )
            * ) / 14400
            )::INTEGER
*         ) AS regenerated
        *ROM players
        WHERE id = $1
*       FOR UPDATE
      )
      UP*ATE players AS player
      SET
  *     energy = LEAST(
          5,
*         current_player.energy +
 *        current_player.regenerated*        ),
        last_energy_at * CASE
          WHEN current_playe*.energy >= 5
            THEN curr*nt_player.last_energy_at

        * WHEN current_player.energy +
    *          current_player.regenerat*d >= 5
            THEN CURRENT_TI*ESTAMP

          WHEN current_pla*er.regenerated > 0
            THE* current_player.last_energy_at +
 *               current_player.rege*erated *
                 INTERVAL*'4 hours'

          ELSE current_*layer.last_energy_at
        END
 *    FROM current_player
      WHER* player.id = current_player.id
   *  RETURNING
        player.id,
   *    player.username,
        playe*.class,
        player.energy,
   *    player.last_energy_at
      `,*      [playerId]
    );

    const*player = playerResult.rows[0];

  * if (!player) {
      await client*query("ROLLBACK");

      return json(
        { error: "Player not found." },
        404
      );
    }

    if (player.class !== requiredClass) {
      await client.query("ROLLBACK");

      return json(
        {
          error:
            `${requiredClass} class required for this action.`,
        },
        403
      );
    }

    if (Number(player.energy) <= 0) {
      await client.query("ROLLBACK");

      return json(
        { error: "Not enough energy." },
        409
      );
    }

    /*
      Lock the shared war row so simultaneous players
      cannot overwrite one another.
    */
    const existingWarResult = aw*it client.query(
      `
      SEL*CT id
      FROM war_state
      W*ERE id = 1
      FOR UPDATE
      *
    );

    if (existingWarResult*rows.length === 0) {
      await c*ient.query("ROLLBACK");

      ret*rn json(
        { error: "Global *ar state not found." },
        40*
      );
    }

    if (action ==* "attack") {
      await client.qu*ry(
        `
        UPDATE war_s*ate
        SET
          fleet_pe*cent =
            GREATEST(0, fle*t_percent - 0.05),
          updat*d_at = CURRENT_TIMESTAMP
        W*ERE id = 1
        `
      );
    *

    if (action === "fortify") {
      await client.query(
        `
        UPDATE war_state
        SET
          defense =
            LEAST(120, defense + 2),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
        `
      );
    }

    if (action === "restore") {
      await client.query(
        `
        UPDATE war_state
        SET
          integrity =
            LEAST(120, integrity + 2),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
        `
      );
    }

    /*
      Spend energy only after the global update succeeds.
    */
    const updatedPlayerResult =
*     await client.query<PlayerRow>*
        `
        UPDATE players
*       SET
          energy = ener*y - 1,
          last_energy_at = *ASE
            WHEN energy >= 5
 *            THEN CURRENT_TIMESTAMP*            ELSE last_energy_at
  *       END
        WHERE id = $1
 *      RETURNING
          id,
    *     username,
          class,
  *       energy,
          last_energy_at
        `,
        [playerId]
      );

    const updatedWarResult = await client.query(
      `
      SELECT
        day,
        fleet_percent,
        defense,
        integrity,
        next_cycle_at,
        updated_at
      FROM war_state
      WHERE id = 1
      `
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
        last_energy_at:
          updatedPlayer.last_energy_at,
      },

      war: {
        day: Number(updatedWar.day),
        fleetPercent:
          Number(updatedWar.fleet_percent),
        defense:
          Number(updatedWar.defense),
        integrity:
          Number(updatedWar.integrity),
        nextCycleAt:
          updatedWar.next_cycle_at,
        updatedAt:
          updatedWar.updated_at,
      },
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Global war action failed",
      error
    );

    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to complete war action.",
      },
      500
    );

  } finally {
    client.release();
  }
};

export const config: Config = {
  path: "/api/war/action",
  method: "POST",
};

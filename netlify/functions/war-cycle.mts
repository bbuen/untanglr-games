import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

const DEFENSE_DAMAGE_PER_CYCLE = 8;
const INTEGRITY_DAMAGE_PER_CYCLE = 20;
const CYCLE_HOURS = 24;
const MAX_CATCH_UP_CYCLES = 30;

type WarRow = {
  day: number | string;
  fleet_percent: number | string;
  defense: number | string;
  integrity: number | string;
  next_cycle_at: Date | string;
  updated_at: Date | string;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export default async (): Promise<Response> => {
  const database = getDatabase();
  const client = await database.pool.connect();

  try {
    await client.query("BEGIN");

    const currentResult = await client.query<WarRow>(
      `SELECT day,
              fleet_percent,
              defense,
              integrity,
              next_cycle_at,
              updated_at
       FROM war_state
       WHERE id = 1
       FOR UPDATE`,
    );

    const current = currentResult.rows[0];

    if (!current) {
      await client.query("ROLLBACK");
      return json({ error: "Global war state not found." }, 404);
    }

    const now = Date.now();
    const nextCycleAt = new Date(current.next_cycle_at).getTime();

    if (!Number.isFinite(nextCycleAt)) {
      await client.query("ROLLBACK");
      return json({ error: "Invalid next_cycle_at value." }, 500);
    }

    if (now < nextCycleAt) {
      await client.query("COMMIT");
      return json({
        success: true,
        cyclesApplied: 0,
        message: "The next Bombardier cycle is not due yet.",
        nextCycleAt: current.next_cycle_at,
      });
    }

    const cycleMs = CYCLE_HOURS * 60 * 60 * 1000;
    const overdueCycles = Math.floor((now - nextCycleAt) / cycleMs) + 1;
    const cyclesToApply = Math.min(overdueCycles, MAX_CATCH_UP_CYCLES);

    let defense = Number(current.defense);
    let integrity = Number(current.integrity);

    for (let cycle = 0; cycle < cyclesToApply; cycle += 1) {
      const defenseBefore = Math.max(0, defense);
      const defenseAfter = Math.max(0, defenseBefore - DEFENSE_DAMAGE_PER_CYCLE);
      const defenseOverflow = Math.max(
        0,
        DEFENSE_DAMAGE_PER_CYCLE - defenseBefore,
      );

      defense = defenseAfter;

      if (defenseAfter <= 0) {
        integrity = Math.max(
          0,
          integrity - INTEGRITY_DAMAGE_PER_CYCLE - defenseOverflow,
        );
      }
    }

    const updatedResult = await client.query<WarRow>(
      `UPDATE war_state
       SET day = day + $1,
           defense = $2,
           integrity = $3,
           next_cycle_at = next_cycle_at + ($1 * INTERVAL '24 hours'),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 1
       RETURNING day,
                 fleet_percent,
                 defense,
                 integrity,
                 next_cycle_at,
                 updated_at`,
      [cyclesToApply, defense, integrity],
    );

    await client.query("COMMIT");

    const war = updatedResult.rows[0];

    return json({
      success: true,
      cyclesApplied: cyclesToApply,
      damagePerCycle: {
        defense: DEFENSE_DAMAGE_PER_CYCLE,
        integrity: INTEGRITY_DAMAGE_PER_CYCLE,
      },
      war: {
        day: Number(war.day),
        fleetPercent: Number(war.fleet_percent),
        defense: Number(war.defense),
        integrity: Number(war.integrity),
        nextCycleAt: war.next_cycle_at,
        updatedAt: war.updated_at,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Bombardier war cycle failed", error);

    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to run the Bombardier war cycle.",
      },
      500,
    );
  } finally {
    client.release();
  }
};

export const config: Config = {
  schedule: "0 * * * *",
};

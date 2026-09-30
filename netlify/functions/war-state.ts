import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export default async (): Promise<Response> => {
  const database = getDatabase();
  const client = await database.pool.connect();

  try {

    // Temporary auto-create
    await client.query(`
      CREATE TABLE IF NOT EXISTS war_state (
        id INTEGER PRIMARY KEY,
        day INTEGER NOT NULL DEFAULT 1,
        fleet_percent NUMERIC(7,3) NOT NULL DEFAULT 100,
        defense NUMERIC(7,3) NOT NULL DEFAULT 100,
        integrity NUMERIC(7,3) NOT NULL DEFAULT 100,
        next_cycle_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP + INTERVAL '24 hours',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      INSERT INTO war_state (
        id,
        day,
        fleet_percent,
        defense,
        integrity
      )
      VALUES (
        1,
        1,
        100,
        100,
        100
      )
      ON CONFLICT (id) DO NOTHING
    `);

    const result = await client.query(`
      SELECT
        day,
        fleet_percent,
        defense,
        integrity,
        next_cycle_at,
        updated_at
      FROM war_state
      WHERE id = 1
    `);

    return json({
      war: result.rows[0]
    });

  } catch (error) {

    console.error(error);

    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unknown error"
      },
      500
    );

  } finally {

    client.release();

  }
};

export const config: Config = {
  path: "/api/war/state",
  method: "GET",
};

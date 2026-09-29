import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

type RequestBody = {
  playerId?: number | string;
  class?: string;
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export default async (req: Request): Promise<Response> => {

  let body: RequestBody;

  try {
    body = await req.json();
  } catch {
    return json(
      { error: "Invalid JSON request body." },
      400
    );
  }

  const playerId = body.playerId;
  const className = String(body.class || "");

  const validClasses = [
    "Warrior",
    "Defender",
    "Healer"
  ];

  if (!playerId) {
    return json(
      { error: "Missing playerId." },
      400
    );
  }

  if (!validClasses.includes(className)) {
    return json(
      { error: "Invalid class." },
      400
    );
  }

  const database = getDatabase();
  const client = await database.pool.connect();

  try {

    const result = await client.query(
      `
      UPDATE players
      SET class = $1
      WHERE id = $2
      RETURNING
        id,
        username,
        class,
        energy,
        last_energy_at
      `,
      [
        className,
        playerId
      ]
    );

    if (result.rows.length === 0) {

      return json(
        { error: "Player not found." },
        404
      );

    }

    return json({
      success: true,
      player: result.rows[0]
    });

  } catch(error) {

    console.error(error);

    return json(
      {
        error: "Unable to update class."
      },
      500
    );

  } finally {

    client.release();

  }

};

export const config: Config = {
  path: "/api/players/class",
  method: "POST",
};

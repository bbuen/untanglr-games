import { getDatabase } from "@netlify/database";
import type { Config, Context } from "@netlify/functions";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

const behaviours = [
  "The cat watches the room silently.",
  "The cat sits facing the doorway.",
  "The cat settles into a familiar spot.",
  "The cat appears difficult to read.",
  "The cat briefly wanders before settling again.",
  "The cat quietly observes nearby activity.",
];

export default async (
  _req: Request,
  _context: Context,
): Promise<Response> => {
  const database = getDatabase();
  const client = await database.pool.connect();

  try {
    const result = await client.query(
      `
      SELECT *
      FROM mochi_state
      WHERE id = 1
      LIMIT 1
      `,
    );

    const cat = result.rows[0];

    if (!cat) {
      return json(
        {
          error: "Cat state not found.",
        },
        404,
      );
    }

    const daysCaredFor = Math.max(
      1,
      Math.floor(
        (Date.now() -
          new Date(cat.era_started_at).getTime()) /
          86400000,
      ) + 1,
    );

    return json({
      name: cat.name,
      generation: cat.generation,
      departure_stage: cat.departure_stage,
      stability: cat.stability,
      departed: cat.departed,
      total_actions: cat.total_actions,
      days_cared_for: daysCaredFor,

      state_name:
        cat.departure_stage >= 3
          ? "Distant"
          : cat.departure_stage >= 1
          ? "Uneasy"
          : "Observing",

      behaviour:
        behaviours[
          Math.floor(Math.random() * behaviours.length)
        ],
    });
  } catch (error) {
    console.error("Failed to load cat state", error);

    return json(
      {
        error: "Unable to load cat state.",
      },
      500,
    );
  } finally {
    client.release();
  }
};

export const config: Config = {
  path: "/api/mochi/state",
  method: "GET",
};
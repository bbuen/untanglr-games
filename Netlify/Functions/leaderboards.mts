import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

type LeaderboardRow = {
  rank: string | number;
  player_id: string | number;
  username: string;
  class: string;
  score: string | number;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "public, max-age=30" },
  });
}

export default async (req: Request): Promise<Response> => {
  const requestedLimit = Number(new URL(req.url).searchParams.get("limit") ?? "10");
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return json({ error: "Limit must be an integer from 1 to 100." }, 400);
  }

  try {
    const database = getDatabase();
    const [warriors, defenders, healers] = await Promise.all([
      database.pool.query<LeaderboardRow>(
        `SELECT ROW_NUMBER() OVER (ORDER BY fleet_damage_dealt DESC, created_at ASC, id ASC) AS rank,
                id AS player_id, username, class, fleet_damage_dealt AS score
         FROM players
         ORDER BY fleet_damage_dealt DESC, created_at ASC, id ASC
         LIMIT $1`,
        [requestedLimit],
      ),
      database.pool.query<LeaderboardRow>(
        `SELECT ROW_NUMBER() OVER (ORDER BY defense_restored DESC, created_at ASC, id ASC) AS rank,
                id AS player_id, username, class, defense_restored AS score
         FROM players
         ORDER BY defense_restored DESC, created_at ASC, id ASC
         LIMIT $1`,
        [requestedLimit],
      ),
      database.pool.query<LeaderboardRow>(
        `SELECT ROW_NUMBER() OVER (ORDER BY integrity_restored DESC, created_at ASC, id ASC) AS rank,
                id AS player_id, username, class, integrity_restored AS score
         FROM players
         ORDER BY integrity_restored DESC, created_at ASC, id ASC
         LIMIT $1`,
        [requestedLimit],
      ),
    ]);

    return json({
      top_warriors: warriors.rows,
      top_defenders: defenders.rows,
      top_healers: healers.rows,
    });
  } catch (error) {
    console.error("Leaderboard lookup failed", error);
    return json({ error: "Unable to load leaderboards right now." }, 500);
  }
};

export const config: Config = {
  path: "/api/leaderboards",
  method: "GET",
};

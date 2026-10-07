import { getDatabase } from "@netlify/database";
import type { Config, Context } from "@netlify/functions";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export default async (_req: Request, _context: Context): Promise<Response> => {
  const database = getDatabase();
  const client = await database.pool.connect();

  try {
    await client.query("BEGIN");

    // One row represents the single shared, current Mochi.
    await client.query(`
      CREATE TABLE IF NOT EXISTS mochi_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL DEFAULT 'Mochi',
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),

        hunger NUMERIC(6,2) NOT NULL DEFAULT 75 CHECK (hunger BETWEEN 0 AND 130),
        sleep NUMERIC(6,2) NOT NULL DEFAULT 75 CHECK (sleep BETWEEN 0 AND 130),
        play NUMERIC(6,2) NOT NULL DEFAULT 75 CHECK (play BETWEEN 0 AND 130),
        cleanliness NUMERIC(6,2) NOT NULL DEFAULT 75 CHECK (cleanliness BETWEEN 0 AND 130),
        affection NUMERIC(6,2) NOT NULL DEFAULT 75 CHECK (affection BETWEEN 0 AND 130),

        stability NUMERIC(6,2) NOT NULL DEFAULT 100 CHECK (stability BETWEEN 0 AND 100),
        departure_stage INTEGER NOT NULL DEFAULT 0 CHECK (departure_stage BETWEEN 0 AND 5),
        departed BOOLEAN NOT NULL DEFAULT FALSE,

        total_actions BIGINT NOT NULL DEFAULT 0 CHECK (total_actions >= 0),
        era_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_needs_update_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Every community button press is stored here and can later be resolved in cycles.
    await client.query(`
      CREATE TABLE IF NOT EXISTS mochi_actions (
        id BIGSERIAL PRIMARY KEY,
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
        action TEXT NOT NULL CHECK (action IN ('feed', 'play', 'pet', 'brush', 'rest')),
        player_token TEXT,
        cycle_key TEXT,
        processed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Permanent record of completed generations.
    await client.query(`
      CREATE TABLE IF NOT EXISTS mochi_generations (
        id BIGSERIAL PRIMARY KEY,
        generation INTEGER NOT NULL UNIQUE CHECK (generation > 0),
        cat_name TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        days_cared_for INTEGER NOT NULL DEFAULT 0 CHECK (days_cared_for >= 0),
        total_actions BIGINT NOT NULL DEFAULT 0 CHECK (total_actions >= 0),
        total_feeds BIGINT NOT NULL DEFAULT 0 CHECK (total_feeds >= 0),
        total_plays BIGINT NOT NULL DEFAULT 0 CHECK (total_plays >= 0),
        total_pets BIGINT NOT NULL DEFAULT 0 CHECK (total_pets >= 0),
        total_brushes BIGINT NOT NULL DEFAULT 0 CHECK (total_brushes >= 0),
        total_rests BIGINT NOT NULL DEFAULT 0 CHECK (total_rests >= 0),
        most_common_action TEXT,
        final_departure_stage INTEGER CHECK (final_departure_stage BETWEEN 0 AND 5),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Interesting moments that may later appear as Era Memories.
    await client.query(`
      CREATE TABLE IF NOT EXISTS mochi_memories (
        id BIGSERIAL PRIMARY KEY,
        generation INTEGER NOT NULL CHECK (generation > 0),
        memory_type TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Useful indexes for community-cycle processing and history screens.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mochi_actions_unprocessed
      ON mochi_actions (created_at)
      WHERE processed_at IS NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mochi_actions_generation
      ON mochi_actions (generation, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mochi_actions_cycle
      ON mochi_actions (cycle_key)
      WHERE cycle_key IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mochi_memories_generation
      ON mochi_memories (generation, created_at DESC)
    `);

    // Seed the shared cat. This is safe to run repeatedly.
    await client.query(`
      INSERT INTO mochi_state (id, name, generation)
      VALUES (1, 'Mochi', 1)
      ON CONFLICT (id) DO NOTHING
    `);

    // Seed the first generation record. This is also safe to run repeatedly.
    await client.query(`
      INSERT INTO mochi_generations (generation, cat_name, started_at)
      SELECT generation, name, era_started_at
      FROM mochi_state
      WHERE id = 1
      ON CONFLICT (generation) DO NOTHING
    `);

    await client.query("COMMIT");

    return json({
      success: true,
      message: "Global Cat database tables are ready.",
      tables: [
        "mochi_state",
        "mochi_actions",
        "mochi_generations",
        "mochi_memories",
      ],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Global Cat database setup failed", error);
    return json(
      {
        success: false,
        error: "Unable to create the Global Cat database tables.",
      },
      500,
    );
  } finally {
    client.release();
  }
};

export const config: Config = {
  path: "/api/setup-global-cat",
  method: "GET",
};

import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;
const PIN_PATTERN = /^\d{4}$/;

type LoginBody = {
  username?: unknown;
  pin?: unknown;
};

type PlayerRow = {
  id: string | number;
  username: string;
  pin_hash: string;
  class: string;
  energy: number;
  last_energy_at: Date | string;
  created_at: Date | string;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scrypt(pin, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64")}$${derivedKey.toString("base64")}`;
}

async function verifyPin(pin: string, storedHash: string): Promise<boolean> {
  const [algorithm, saltText, hashText] = storedHash.split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;

  try {
    const salt = Buffer.from(saltText, "base64");
    const expected = Buffer.from(hashText, "base64");
    const actual = (await scrypt(pin, salt, expected.length)) as Buffer;
    return expected.length > 0 && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function publicPlayer(player: PlayerRow, created: boolean) {
  return {
    player: {
      id: player.id,
      username: player.username,
      class: player.class,
      energy: player.energy,
      last_energy_at: player.last_energy_at,
    },
    created,
  };
}

async function refreshEnergy(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: PlayerRow[] }> },
  playerId: string | number,
): Promise<PlayerRow> {
  const refreshedResult = await client.query(
    `WITH current_player AS (
       SELECT *, GREATEST(
         0,
         FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - last_energy_at)) / 14400)::INTEGER
       ) AS regenerated
       FROM players
       WHERE id = $1
       FOR UPDATE
     )
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
     RETURNING player.id, player.username, player.pin_hash, player.class,
               player.energy, player.last_energy_at, player.created_at`,
    [playerId],
  );

  return refreshedResult.rows[0];
}

export default async (req: Request): Promise<Response> => {
  let body: LoginBody;

  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const pin = typeof body.pin === "string" ? body.pin : "";

  if (!USERNAME_PATTERN.test(username)) {
    return json({ error: "Username must be 3-24 letters, numbers, or underscores." }, 400);
  }
  if (!PIN_PATTERN.test(pin)) {
    return json({ error: "PIN must be exactly 4 digits." }, 400);
  }

  const database = getDatabase();
  const client = await database.pool.connect();

  try {
    await client.query("BEGIN");
    // Serialize account creation and login attempts for the same username.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [username]);

    const existingResult = await client.query<PlayerRow>(
      `SELECT id, username, pin_hash, class, energy, last_energy_at, created_at
       FROM players
       WHERE username = $1`,
      [username],
    );
    const existing = existingResult.rows[0];

    if (existing) {
      const validPin = await verifyPin(pin, existing.pin_hash);
      if (!validPin) {
        await client.query("ROLLBACK");
        return json({ error: "Invalid username or PIN." }, 401);
      }

      const refreshed = await refreshEnergy(client, existing.id);
      await client.query("COMMIT");
      return json(publicPlayer(refreshed, false));
    }

    const pinHash = await hashPin(pin);
    const insertedResult = await client.query<PlayerRow>(
      `INSERT INTO players (username, pin_hash)
       VALUES ($1, $2)
       RETURNING id, username, pin_hash, class, energy, last_energy_at, created_at`,
      [username, pinHash],
    );

    await client.query("COMMIT");
    return json(publicPlayer(insertedResult.rows[0], true), 201);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Player login failed", error);
    return json({ error: "Unable to log in right now." }, 500);
  } finally {
    client.release();
  }
};

export const config: Config = {
  path: "/api/players/login",
  method: "POST",
};

import { createHash, randomBytes } from "node:crypto";
import type { Executor } from "../db/index.js";

// The cookie carries a random token; the database stores only its SHA-256, so
// a leaked copy of the session table cannot be replayed as cookies.
export const SESSION_COOKIE = "__Host-sid";
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 12 * 3600 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(ex: Executor, personId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await ex
    .insertInto("session")
    .values({
      token_hash: hash(token),
      person_id: personId,
      expires_at: new Date(Date.now() + ABSOLUTE_MS),
    })
    .execute();
  return token;
}

export async function resolveSession(
  ex: Executor,
  token: string | undefined,
): Promise<string | null> {
  if (!token) return null;
  const s = await ex
    .selectFrom("session")
    .selectAll()
    .where("token_hash", "=", hash(token))
    .executeTakeFirst();
  if (!s) return null;
  const now = Date.now();
  if (s.expires_at.getTime() <= now || s.last_seen_at.getTime() + IDLE_MS <= now) {
    await ex.deleteFrom("session").where("token_hash", "=", s.token_hash).execute();
    return null;
  }
  if (now - s.last_seen_at.getTime() > TOUCH_EVERY_MS) {
    await ex
      .updateTable("session")
      .set({ last_seen_at: new Date(now) })
      .where("token_hash", "=", s.token_hash)
      .execute();
  }
  return s.person_id;
}

export async function endSession(ex: Executor, token: string): Promise<void> {
  await ex.deleteFrom("session").where("token_hash", "=", hash(token)).execute();
}

export async function endAllSessions(ex: Executor, personId: string): Promise<void> {
  await ex.deleteFrom("session").where("person_id", "=", personId).execute();
}

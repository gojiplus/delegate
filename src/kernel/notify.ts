import type { Executor } from "../db/index.js";
import { newId } from "./ids.js";

// Out-of-band notices. The point is that the owner, and someone independent of
// every delegate, hear about changes to authority and money through a channel
// the delegate does not control. R0 writes them to an outbox that the app
// displays; R1 delivers them by email or SMS.

export interface Notice {
  ownerId: string;
  kind: string;
  message: string;
  toOwner?: boolean;
  toTrustedContact?: boolean;
  toPeople?: string[];
}

export async function notify(ex: Executor, n: Notice): Promise<void> {
  const rows: { recipient_person_id: string | null; recipient_email: string | null }[] = [];
  if (n.toOwner) rows.push({ recipient_person_id: n.ownerId, recipient_email: null });
  for (const p of n.toPeople ?? []) rows.push({ recipient_person_id: p, recipient_email: null });
  if (n.toTrustedContact) {
    const tc = await ex
      .selectFrom("trusted_contact")
      .select("email")
      .where("owner_id", "=", n.ownerId)
      .executeTakeFirst();
    if (tc) rows.push({ recipient_person_id: null, recipient_email: tc.email });
  }
  if (!rows.length) return;
  await ex
    .insertInto("notification")
    .values(
      rows.map((r) => ({
        id: newId("note"),
        owner_id: n.ownerId,
        kind: n.kind,
        message: n.message,
        ...r,
      })),
    )
    .execute();
}

export async function noticesFor(ex: Executor, personId: string) {
  return ex
    .selectFrom("notification")
    .select(["id", "kind", "message", "created_at"])
    .where("recipient_person_id", "=", personId)
    .orderBy("created_at", "desc")
    .limit(50)
    .execute();
}

import { z } from "zod";
import { audit } from "./audit.js";
import { digestOf } from "./canonical.js";
import type { Kernel } from "./context.js";
import { newId } from "./ids.js";
import { notify } from "./notify.js";
import { KernelError } from "./registry.js";
import { consumeStepUp } from "./stepup.js";

// A trusted contact is told about changes to authority and money. To be worth
// anything they must be independent of the delegates, so the same person can
// never be both (the idea follows FINRA Rule 4512's trusted contact person).

export const TrustedContactInput = z.object({ name: z.string().min(1).max(100), email: z.email() });
export type TrustedContactInput = z.infer<typeof TrustedContactInput>;

// Treat "sam+tc@example.test" and "Sam@example.test" as the same person.
export function sameMailbox(email: string): string {
  const [local = "", domain = ""] = email.toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
}

export function contactDigest(ownerId: string, c: TrustedContactInput) {
  return digestOf({ op: "trusted_contact", ownerId, name: c.name, email: c.email.toLowerCase() });
}

export async function delegateEmails(k: Kernel, ownerId: string): Promise<string[]> {
  const rows = await k.db
    .selectFrom("delegation_grant as g")
    .innerJoin("person as p", "p.id", "g.delegate_id")
    .select("p.email")
    .where("g.grantor_id", "=", ownerId)
    .where("g.status", "<>", "revoked")
    .execute();
  return rows.map((r) => sameMailbox(r.email));
}

export async function setTrustedContact(
  k: Kernel,
  ownerId: string,
  input: TrustedContactInput,
  stepUp: unknown,
) {
  const c = { ...input, email: input.email.toLowerCase() };
  const owner = await k.db
    .selectFrom("person")
    .select("email")
    .where("id", "=", ownerId)
    .executeTakeFirstOrThrow();
  if (sameMailbox(c.email) === sameMailbox(owner.email))
    throw new KernelError("invalid", "your trusted contact must be someone else");
  if ((await delegateEmails(k, ownerId)).includes(sameMailbox(c.email))) {
    throw new KernelError(
      "invalid",
      "a trusted contact cannot also be someone who helps with your accounts",
    );
  }
  await k.db.transaction().execute(async (tx) => {
    await consumeStepUp(tx, k.stepUp, ownerId, "grant", contactDigest(ownerId, c), stepUp);
    const previous = await tx
      .selectFrom("trusted_contact")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .executeTakeFirst();
    if (previous) {
      await tx
        .insertInto("notification")
        .values({
          id: newId("note"),
          owner_id: ownerId,
          recipient_person_id: null,
          recipient_email: previous.email,
          kind: "trusted_contact.replaced",
          message: "You are no longer the trusted contact for this FamilyOps account.",
        })
        .execute();
    }
    await tx
      .insertInto("trusted_contact")
      .values({ owner_id: ownerId, name: c.name, email: c.email })
      .onConflict((oc) => oc.column("owner_id").doUpdateSet({ name: c.name, email: c.email }))
      .execute();
    await notify(tx, {
      ownerId,
      kind: "trusted_contact.set",
      message: `${c.name} is now your trusted contact and will be told about changes to who can help you and about payments.`,
      toOwner: true,
      toTrustedContact: true,
    });
    await audit(tx, {
      actorId: ownerId,
      actorKind: "person",
      ownerId,
      action: "trusted_contact.set",
      detail: { replaced: previous !== undefined },
    });
  });
}

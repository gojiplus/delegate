import { randomBytes } from "node:crypto";
import type { Tx } from "../db/index.js";
import { KernelError } from "./registry.js";

// Step-up authentication for anything that expands authority or moves money:
// creating or widening a grant, approving an intent, finishing recovery. Each
// challenge is bound to a purpose and to the digest of the exact thing being
// authorised, and is single-use. A link in an email or a notification only
// opens the screen; it can never supply this proof.

export type StepUpPurpose = "grant" | "approve" | "register" | "recovery";

export interface StepUpVerifier {
  // Reads the challenge the client signed, without trusting anything else yet.
  challengeOf(response: unknown): string | null;
  // Verifies the response against the person's registered credentials.
  verify(
    tx: Tx,
    personId: string,
    expectedChallenge: string,
    response: unknown,
  ): Promise<Record<string, unknown>>;
}

const TTL_MS = 5 * 60 * 1000;

export async function issueChallenge(
  tx: Tx,
  personId: string,
  purpose: StepUpPurpose,
  bindingDigest: string | null,
): Promise<string> {
  const challenge = randomBytes(32).toString("base64url");
  await tx
    .insertInto("stepup_challenge")
    .values({
      challenge,
      person_id: personId,
      purpose,
      binding_digest: bindingDigest,
      expires_at: new Date(Date.now() + TTL_MS),
    })
    .execute();
  return challenge;
}

export async function consumeStepUp(
  tx: Tx,
  verifier: StepUpVerifier,
  personId: string,
  purpose: StepUpPurpose,
  bindingDigest: string | null,
  response: unknown,
): Promise<Record<string, unknown>> {
  const challenge = verifier.challengeOf(response);
  if (!challenge) throw new KernelError("stepup_required", "step-up authentication required");
  const row = await tx
    .selectFrom("stepup_challenge")
    .selectAll()
    .where("challenge", "=", challenge)
    .forUpdate()
    .executeTakeFirst();
  const valid =
    row &&
    row.person_id === personId &&
    row.purpose === purpose &&
    row.binding_digest === bindingDigest &&
    row.used_at === null &&
    row.expires_at.getTime() > Date.now();
  if (!valid) throw new KernelError("stepup_required", "step-up challenge invalid for this action");
  const evidence = await verifier.verify(tx, personId, challenge, response);
  await tx
    .updateTable("stepup_challenge")
    .set({ used_at: new Date() })
    .where("challenge", "=", challenge)
    .execute();
  return { ...evidence, challenge, purpose, binding_digest: bindingDigest };
}

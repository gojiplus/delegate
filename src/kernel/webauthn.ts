import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Tx } from "../db/index.js";
import { audit } from "./audit.js";
import type { Kernel } from "./context.js";
import { notify } from "./notify.js";
import { KernelError } from "./registry.js";
import {
  consumeStepUp,
  issueChallenge,
  type StepUpPurpose,
  type StepUpVerifier,
} from "./stepup.js";

// Passkeys via @simplewebauthn/server. The kernel issues and tracks
// challenges itself (bound to purpose and digest); this file only turns them
// into WebAuthn options and checks signatures.

export interface RelyingParty {
  id: string;
  name: string;
  origin: string;
}

function clientChallenge(response: unknown): string | null {
  const cd = (response as { response?: { clientDataJSON?: unknown } })?.response?.clientDataJSON;
  if (typeof cd !== "string") return null;
  try {
    const parsed = JSON.parse(Buffer.from(cd, "base64url").toString("utf8")) as {
      challenge?: unknown;
    };
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}

export function passkeyVerifier(rp: RelyingParty): StepUpVerifier {
  return {
    challengeOf: clientChallenge,
    async verify(tx: Tx, personId: string, expectedChallenge: string, response: unknown) {
      const r = response as AuthenticationResponseJSON;
      const cred = await tx
        .selectFrom("webauthn_credential")
        .selectAll()
        .where("id", "=", r.id)
        .where("person_id", "=", personId)
        .forUpdate()
        .executeTakeFirst();
      if (!cred) throw new KernelError("stepup_required", "unknown passkey for this person");
      const result = await verifyAuthenticationResponse({
        response: r,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(cred.public_key),
          counter: Number(cred.counter),
          transports: cred.transports as AuthenticatorTransport[],
        },
        requireUserVerification: true,
      });
      if (!result.verified) throw new KernelError("stepup_required", "passkey verification failed");
      await tx
        .updateTable("webauthn_credential")
        .set({ counter: result.authenticationInfo.newCounter })
        .where("id", "=", cred.id)
        .execute();
      return {
        method: "passkey",
        credentialId: cred.id,
        userVerified: result.authenticationInfo.userVerified,
      };
    },
  };
}

export const enrolBinding = (personId: string) => `enrol:${personId}`;

// Adding a passkey is the most dangerous thing a session can do, because a
// passkey is what approves payments, so a session alone never suffices. With
// a passkey already enrolled, adding another needs a fresh assertion from an
// existing one; with none, only inside the window opened by account creation
// or by completed recovery verification.
export async function registrationOptions(
  k: Kernel,
  rp: RelyingParty,
  personId: string,
  stepUp?: unknown,
) {
  const person = await k.db
    .selectFrom("person")
    .selectAll()
    .where("id", "=", personId)
    .executeTakeFirstOrThrow();
  const existing = await k.db
    .selectFrom("webauthn_credential")
    .select(["id"])
    .where("person_id", "=", personId)
    .execute();
  const challenge = await k.db.transaction().execute(async (tx) => {
    if (existing.length) {
      await consumeStepUp(tx, k.stepUp, personId, "enrol", enrolBinding(personId), stepUp);
    } else if (
      !person.enrolment_open_until ||
      person.enrolment_open_until.getTime() <= Date.now()
    ) {
      throw new KernelError(
        "stepup_required",
        "adding a passkey needs an existing passkey or account recovery",
      );
    }
    return issueChallenge(tx, personId, "register", null);
  });
  return generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: person.email,
    userDisplayName: person.display_name,
    userID: new TextEncoder().encode(person.id),
    challenge: Buffer.from(challenge, "base64url"),
    excludeCredentials: existing.map((c) => ({ id: c.id })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
}

export async function registerPasskey(
  k: Kernel,
  rp: RelyingParty,
  personId: string,
  response: RegistrationResponseJSON,
) {
  await k.db.transaction().execute(async (tx) => {
    const challenge = clientChallenge(response);
    const verifier: StepUpVerifier = {
      challengeOf: () => challenge,
      async verify(_tx, _personId, expectedChallenge) {
        const result = await verifyRegistrationResponse({
          response,
          expectedChallenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.id,
          requireUserVerification: true,
        });
        if (!result.verified)
          throw new KernelError("stepup_required", "passkey registration failed");
        const c = result.registrationInfo.credential;
        await tx
          .insertInto("webauthn_credential")
          .values({
            id: c.id,
            person_id: personId,
            public_key: Buffer.from(c.publicKey),
            counter: c.counter,
            transports: c.transports ?? [],
          })
          .execute();
        return { method: "passkey_registration", credentialId: c.id };
      },
    };
    await consumeStepUp(tx, verifier, personId, "register", null, response);
    await tx
      .updateTable("person")
      .set({ enrolment_open_until: null })
      .where("id", "=", personId)
      .execute();
    await notify(tx, {
      ownerId: personId,
      kind: "passkey.added",
      message:
        "A new passkey was added to your account. If this wasn't you, stop all payments and contact support.",
      toOwner: true,
      toTrustedContact: true,
    });
    await audit(tx, {
      actorId: personId,
      actorKind: "person",
      ownerId: personId,
      action: "passkey.registered",
    });
  });
}

// Options for a step-up assertion bound to one purpose and digest.
export async function stepUpOptions(
  k: Kernel,
  rp: RelyingParty,
  personId: string,
  purpose: StepUpPurpose,
  bindingDigest: string | null,
) {
  const creds = await k.db
    .selectFrom("webauthn_credential")
    .select(["id", "transports"])
    .where("person_id", "=", personId)
    .execute();
  if (!creds.length) throw new KernelError("stepup_required", "set up a passkey first");
  const challenge = await k.db
    .transaction()
    .execute((tx) => issueChallenge(tx, personId, purpose, bindingDigest));
  return generateAuthenticationOptions({
    rpID: rp.id,
    challenge: Buffer.from(challenge, "base64url"),
    allowCredentials: creds.map((c) => ({ id: c.id })),
    userVerification: "required",
  });
}

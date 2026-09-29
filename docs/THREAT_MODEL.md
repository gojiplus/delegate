# Threat model

This document is the security specification. Every control listed as present names the test that fails
without it. A control without such a test is listed as a gap.

## What we protect

In order of harm:

1. **Money.** Nothing may be sent without the owner's approval of that exact payment, and nothing may be sent
   twice.
2. **Authority.** Only the owner can decide who can see or do what with their accounts.
3. **Financial information.** Balances, transactions and bills are visible only to the owner and the people
   they chose, and only for what they chose.
4. **The record.** What happened, who did it, and under which grant must be recoverable and tamper-evident.

## Who attacks, most likely first

### 1. The delegate

FinCEN's review of suspicious-activity reports found a family member involved in **46%** of elder-theft
cases. **Adult children were the most frequent perpetrators, at about 40%**
([FinCEN, 2019](https://www.fincen.gov/system/files/shared/FinCEN%20Financial%20Trend%20Analysis%20Elders_FINAL%20508.pdf)).
The person this product is built for is also its likeliest attacker. A delegate is authenticated and holds a
legitimate grant; they often have physical access to the owner's device, and social leverage over the owner.

| Attack                                                                                       | Control                                                                                                                                                     | Evidence                                                                       |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| See unshared accounts or totals                                                              | One authorisation rule; lists and totals are built from visible resources only                                                                              | `access-property.test.ts`, `grants.test.ts` "scopes reads…"                    |
| Guess another account's ID                                                                   | Unauthorised and nonexistent both return 404                                                                                                                | `grants.test.ts`, `api.test.ts` "404 parity"                                   |
| Widen their own grant                                                                        | Only the grantor can set a grant, and only with their own passkey over the exact grant                                                                      | `grants.test.ts` "never lets a delegate widen…"                                |
| Approve a payment themselves                                                                 | Approval requires actor = owner plus the owner's passkey over the revision digest                                                                           | `payment-flow.test.ts` "lets only the owner approve"                           |
| Get approval for one amount, then change it                                                  | Every change creates a new revision; approval is bound to the digest                                                                                        | `payment-flow.test.ts` "invalidates approval…"                                 |
| Split one payment into many under a limit                                                    | Monthly limit, reserved atomically, and pending payments count                                                                                              | `races.test.ts` "concurrent payments…"                                         |
| Keep acting after being revoked                                                              | Revocation cancels unsent payments at commit; the gate re-checks the grant under lock                                                                       | `races.test.ts`, `controls.test.ts` "revocation cancels…"                      |
| **Add their own passkey to the owner's account while holding the owner's device or session** | Enrolment requires step-up with an existing passkey (hardening #1)                                                                                          | `security.test.ts` "passkey enrolment…"                                        |
| **Act without the owner knowing**                                                            | Out-of-band notices to the owner and a trusted contact (hardening #2)                                                                                       | `security.test.ts` "notifies…"                                                 |
| Start recovery to take over the owner's account                                              | Only the owner or support can start it; recovery freezes execution and revokes sessions                                                                     | `controls.test.ts` "recovery…", `security.test.ts` "recovery revokes sessions" |
| Pressure the owner into approving                                                            | **Residual risk.** Notices to a trusted contact are the only technical control. There is deliberately no cooling-off period (product decision, 2026-09-28). | —                                                                              |

### 2. A scammer coaching the owner

Scams by strangers make up about 80% of elder-exploitation reports. The scammer talks the owner into sharing
with a new "helper" or approving a payment, often in real time on the phone.

- **Controls:**
  - The sharing preview spells out exactly what will be shared.
  - Every payment is approved individually.
  - The approval screen shows who prepared the payment.
  - The trusted contact is notified when authority is granted or widened (hardening #2).
- **Residual risk:** an owner who is coached through every screen in real time. No cooling-off period, by decision. Notifying the trusted contact is the mitigation.

### 3. An external attacker

| Attack                             | Control                                                                                                  | Evidence                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Steal a session cookie             | `__Host-` cookie, HttpOnly, Secure, SameSite=strict; tokens stored as hashes; idle and absolute expiry   | `security.test.ts` "sessions…"                    |
| Use a stolen session to move money | Money and authority always need a passkey; a session alone can do neither, including enrolling a passkey | `security.test.ts` "passkey enrolment…"           |
| CSRF                               | SameSite=strict, plus an `Origin` / `Sec-Fetch-Site` check on every mutation                             | `security.test.ts` "rejects cross-site mutations" |
| XSS                                | React escaping; strict CSP with no inline scripts; fonts self-hosted                                     | `security.test.ts` "security headers"             |
| Brute force or enumeration         | Rate limits on login, step-up and webhooks                                                               | `security.test.ts` "rate limits"                  |
| Replay a step-up                   | Challenges are single-use, bound to a purpose and digest, and expire in 5 minutes                        | `grants.test.ts` "binds the passkey…"             |
| Turn on demo features              | `DEV_LOGIN` is refused when `NODE_ENV=production`                                                        | `security.test.ts` "dev login fails closed"       |

### 4. An insider or support staff

- **Support can:** see payment states and provider references; pause all submissions; freeze an owner.
- **Support cannot:** see amounts or payees; approve anything; lift a freeze.
- **Evidence:** `controls.test.ts` "support can stop…".
- **A database operator:**
  - is fenced in by separate roles for the API, the worker and migrations;
  - cannot `UPDATE`, `DELETE` or `TRUNCATE` the audit log at the role level;
  - is covered by periodically signed checkpoints of the audit chain, which detect tampering after the fact.
- **Evidence:** `security.test.ts` "database roles…" and "audit checkpoints…".

### 5. Supply chain

- Lockfile installs (`npm ci`).
- Dependabot alerts and security updates.
- CodeQL.
- OpenSSF Scorecard.
- `npm audit --audit-level=high` in CI.
- GitHub Actions pinned by SHA.
- Secret scanning with push protection.

### 6. Provider spoofing

- **Controls:**
  - Webhooks carry an HMAC signature over a timestamp and the body, and anything older than 5 minutes is rejected.
  - Event IDs are deduplicated.
  - Stale or conflicting events are resolved by fetching the provider's own state.
- **Evidence:** `failures.test.ts` "webhooks", `security.test.ts` "rejects replayed webhooks".

## Red-team review (2026-09-28)

An independent review, run as a separate agent given this document and the code, found ten exploitable
issues. Each came with a failing test, now in `test/redteam.test.ts`. All are fixed, and each fix was checked
by reverting it and watching its test fail. Several were holes in the delegate model that the earlier tests
never looked for:

| #   | Severity    | Attack                                                                                                                                                                                                                    | Fix                                                                                                                      |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | High        | A delegate rewrote a draft the owner prepared (say, $10 to $5,000). The owner approved; the delegate's limits, revocation, attribution and trusted-contact notice all followed the initiator (the owner), so none applied | Only the preparer or the owner may change a payment                                                                      |
| 2   | Medium–high | A delegate linked a token payment to any owner's bill and got it marked "verified paid"                                                                                                                                   | The bill must belong to the payment's owner, sit on an account the payment touches, and be visible to the preparer       |
| 3   | Medium–high | A session alone could resume paused authority, with no notice                                                                                                                                                             | Resume needs the owner's passkey; the owner and trusted contact are told                                                 |
| 4   | Medium      | A prepare-only delegate recovered the exact balance by probing the "lower than this payment" warning                                                                                                                      | Warnings are shown to the owner only                                                                                     |
| 5   | Medium      | A delegate could pull an approved payment back to "awaiting approval", and the owner's re-approval then failed                                                                                                            | Only a draft can be sent for approval, and only by its preparer or owner                                                 |
| 6   | Medium      | A delegate could dismiss, and so hide, the owner's bills                                                                                                                                                                  | Only the owner can dismiss                                                                                               |
| 7   | Low         | Accepting a request that was no longer pending applied the grant and then reported failure                                                                                                                                | Only pending requests can be accepted                                                                                    |
| 8   | Low         | The app role could postpone queued work by reusing a job key                                                                                                                                                              | Only known tasks are allowed, job keys are derived from the payload, and work can be brought forward but never postponed |
| 9   | Low         | Support's audit export included spending limits                                                                                                                                                                           | Support's export carries actions, actors and times; the chain is verified on the server                                  |
| 10  | Dev only    | Unauthenticated outbox; anyone could simulate someone else's payment outcome                                                                                                                                              | Outbox requires a session and shows only your own; the simulator acts only on your own payments                          |

The reviewer also suspected three things, now addressed:

- **Unsolicited access requests with free-text notes, a scammer's lure.** Only existing delegates can ask for more.
- **Trusted-contact independence could be dodged with plus-addressing.** Addresses are compared case-insensitively and without `+tags`.
- **Support could open an enrolment window by freezing an account with the right reason text.** Recovery is now a state of its own.

## Out of scope for R0

- **Real identity proofing.** Account creation and recovery verification are simulated in R0.
- **Real notification channels.** Notices go to an outbox that the app displays; email and SMS come in R1.
- **Encryption of provider tokens with a key-management service (KMS).** There are no real tokens in R0.
- **Legal authority questions**, such as power of attorney or incapacity (PRD §4).

## Before real data (R1)

- OWASP ASVS 5.0 Level 3, with a requirement-to-test mapping kept in this repo.
- The FTC Safeguards Rule program (subject to counsel's view):
  - a written program and a named person responsible for it
  - a risk assessment
  - MFA and encryption
  - an annual penetration test and vulnerability scans every 6 months
  - incident response, including notifying the FTC within 30 days of a breach affecting 500 or more consumers
- A SOC 2 Type II.
- An external penetration test before live data.
- A bug bounty after launch.

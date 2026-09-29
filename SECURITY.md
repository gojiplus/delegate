# Security policy

FamilyOps handles delegated access to people's finances, so security reports get priority.

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this repository.
Do not open a public issue. We aim to acknowledge within 3 working days.

Include what you did, what happened, and what you expected. A failing test against
`test/` is the most useful form of report.

## Scope

This repository is the **R0 demonstrator**. All accounts, balances and payments are simulated fixtures;
no real financial data exists anywhere in it and no money can move. Findings are still in scope,
because the same authorisation, approval and dispatch code will carry real data in later releases.

Especially wanted:

- any way for a delegate to see or do more than their grant allows
- any way to approve, or cause the dispatch of, a payment without the owner's passkey over that exact request
- any way to make one approved payment execute twice
- any way to alter or delete audit history without detection

The dev-only login (`DEV_LOGIN=1`) and the payment simulator routes are demo features, disabled
outside development; reports that depend on them being enabled are out of scope.

The threat model is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

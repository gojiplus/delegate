import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

// RFC 8785 (JSON Canonicalization Scheme): the same logical object always
// serialises to the same bytes, so a digest identifies the exact content.
export function canonicalJson(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) throw new Error("value cannot be canonicalised");
  return out;
}

export function digestOf(value: unknown): string {
  return "sha256:" + createHash("sha256").update(canonicalJson(value)).digest("hex");
}

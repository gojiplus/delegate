import { useEffect, useState } from "react";
import { type Account, api, ApiError, type Capability, type Me, usd } from "./api";
import { go, useLoad } from "./hooks";

// The person's own calendar date, not UTC: at 5pm in California UTC is already tomorrow.
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const CAP_TEXT: Record<Capability["state"], string> = {
  executable: "Can be sent from the app",
  requires_setup: "Needs setup first",
  external: "Must be paid outside the app",
  unavailable: "Not available",
};

export function Prepare({
  me,
  ownerId,
  workItemId,
}: {
  me: Me;
  ownerId: string;
  workItemId: string | null;
}) {
  const accounts = useLoad<{ accounts: Account[] }>("/api/accounts");
  const payees = useLoad<{ id: string; owner_id: string; label: string }[]>("/api/payees");
  const queue = useLoad<{
    workItems: { id: string; resource_id: string; details: { amountCents?: number | null } }[];
  }>("/api/queue");
  const theirs = accounts.data?.accounts.filter((a) => a.owner_id === ownerId && a.selected) ?? [];
  const sources = theirs.filter((a) => a.kind === "depository");
  const targets = [
    ...theirs.map((a) => ({ id: a.id, label: a.label })),
    ...(payees.data?.filter((p) => p.owner_id === ownerId) ?? []),
  ];
  const work = queue.data?.workItems.find((w) => w.id === workItemId);

  // Form fields fall back to what the bill and the account list suggest until edited.
  const [sourceChoice, setSource] = useState("");
  const [payeeChoice, setPayee] = useState("");
  const [dollarsInput, setDollars] = useState<string | null>(null);
  const source = sourceChoice || sources[0]?.id || "";
  const payee = payeeChoice || work?.resource_id || "";
  const suggested = work?.details.amountCents ? (work.details.amountCents / 100).toFixed(2) : "";
  const dollars = dollarsInput ?? suggested;
  const [date, setDate] = useState(localDate);
  const [cap, setCap] = useState<{ key: string; value: Capability } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // A random key per form: a double click or a retried request returns the same payment.
  const [clickKey] = useState(() => crypto.randomUUID());

  const capKey = `${source}|${payee}`;
  useEffect(() => {
    if (!source || !payee) return;
    api<Capability>("GET", `/api/accounts/${source}/capabilities?payee=${payee}`).then(
      (value) => setCap({ key: `${source}|${payee}`, value }),
      () => setCap(null),
    );
  }, [source, payee]);
  const capability = cap?.key === capKey ? cap.value : null;

  const cents = Math.round(Number(dollars) * 100);
  const submit = async () => {
    try {
      const { intentId } = await api<{ intentId: string }>(
        "POST",
        "/api/payment-intents",
        {
          type: "finance.payment",
          details: {
            sourceAccountId: source,
            payeeResourceId: payee,
            amount: { currency: "USD", cents },
            feeCents: capability?.quotedFeeCents ?? 0,
            scheduledDate: date,
          },
          workItemId,
        },
        { "idempotency-key": clickKey },
      );
      await api("POST", `/api/payment-intents/${intentId}/approval-requests`);
      go(`intent/${intentId}`);
    } catch (e) {
      setErr(
        e instanceof ApiError && e.body.capability
          ? e.body.capability.reason
          : e instanceof Error
            ? e.message
            : String(e),
      );
    }
  };

  const ownerName = theirs[0]?.owner_name ?? (ownerId === me.id ? "you" : "");
  return (
    <main>
      <h1>Prepare a payment{ownerId === me.id ? "" : ` for ${ownerName}`}</h1>
      <p className="soft">
        {ownerId === me.id
          ? "You will be asked to approve it with your passkey."
          : `${ownerName} will see exactly this and decide. Nothing is sent until they approve.`}
      </p>
      <form className="stack" onSubmit={(e) => e.preventDefault()}>
        <label>
          Pay to{" "}
          <select value={payee} onChange={(e) => setPayee(e.target.value)}>
            <option value="">Choose…</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          From{" "}
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({usd(s.balance?.availableCents)} available as of last update)
              </option>
            ))}
          </select>
        </label>
        {capability && (
          <p className={capability.state === "executable" ? "" : "notice"}>
            <strong>{CAP_TEXT[capability.state]}.</strong> {capability.reason}{" "}
            {capability.externalUrl && (
              <a href={capability.externalUrl} target="_blank" rel="noreferrer">
                Open their website
              </a>
            )}
          </p>
        )}
        {capability?.state === "executable" && (
          <>
            <label>
              Amount in dollars{" "}
              <input
                inputMode="decimal"
                value={dollars}
                onChange={(e) => setDollars(e.target.value)}
              />
            </label>
            <label>
              Send on <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <p className="soft small">Fee: {usd(capability.quotedFeeCents ?? 0)}</p>
            {err && <p className="error">{err}</p>}
            <button disabled={!(cents > 0)} onClick={submit}>
              {ownerId === me.id ? "Continue to approval" : `Send to ${ownerName} for approval`}
            </button>
          </>
        )}
      </form>
    </main>
  );
}

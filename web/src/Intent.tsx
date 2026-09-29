import { useState } from "react";
import { api, type IntentView, type Me, usd, when } from "./api";
import { go, useLoad } from "./hooks";
import { sign } from "./passkey";
import { StatusTag, statusLabel } from "./Status";

const WHO: Record<string, string> = {
  system: "FamilyOps",
  provider: "Payment provider (simulated)",
};

function Slip({ v, me, onDone }: { v: IntentView; me: Me; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const deciding = v.owner_id === me.id && v.status === "AwaitingApproval";
  const approve = async () => {
    setBusy(true);
    try {
      setErr(null);
      const opts = await api<{
        options: Parameters<typeof sign>[0];
        revision: { number: number; digest: string };
      }>("POST", `/api/payment-intents/${v.id}/approval-options`);
      const stepUp = await sign(opts.options);
      await api("POST", `/api/payment-intents/${v.id}/approvals`, {
        revision: opts.revision.number,
        digest: opts.revision.digest,
        stepUp,
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="slip" aria-labelledby="slip-title">
      <p id="slip-title">
        {v.initiator_id === v.owner_id ? "You prepared" : `${v.initiator_name} prepared`} a payment
        {v.owner_id === me.id ? " from your account" : ` for ${v.owner_name}`}.
      </p>
      <div className="figure">{usd(v.revision.details.amount.cents)}</div>
      <dl>
        {v.description.lines
          .filter((l) => l.label !== "Amount")
          .map((l) => (
            <div key={l.label} style={{ display: "contents" }}>
              <dt>{l.label}</dt>
              <dd>{l.value}</dd>
            </div>
          ))}
        <dt>Canceling</dt>
        <dd>{v.description.cancellation}</dd>
      </dl>
      {deciding && v.warnings.length > 0 && (
        <div className="notice">
          <strong>Before you decide</strong>
          <ul>
            {v.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="sign">
        {deciding ? (
          <>
            {!me.hasPasskey && (
              <p className="error">Set up a passkey on the home page to approve.</p>
            )}
            {err && <p className="error">{err}</p>}
            <div className="row">
              <button disabled={busy || !me.hasPasskey} onClick={approve}>
                Approve with passkey
              </button>
              <button
                className="danger"
                onClick={() =>
                  api("POST", `/api/payment-intents/${v.id}/rejections`, {}).then(onDone)
                }
              >
                Decline
              </button>
            </div>
            <p className="soft small">
              Your passkey signs this exact payment. If anything changes, you will be asked again.
              There is no time limit.
            </p>
          </>
        ) : (
          <div className="row">
            <StatusTag status={v.status} held={v.hold_reason} />
            {v.status_reason && <span className="soft">{v.status_reason}</span>}
          </div>
        )}
        <p className="digest">Request fingerprint {v.revision.digest}</p>
      </div>
    </section>
  );
}

function Simulator({ v, onDone }: { v: IntentView; onDone: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const advance = async (state: string) => {
    try {
      await api("POST", "/api/dev/fakepay/advance", { intentId: v.id, state });
      setMsg(`Provider reported “${state}”. The worker applies it within a few seconds.`);
      setTimeout(onDone, 2500);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <details>
      <summary>Simulate the payment provider</summary>
      <p className="soft small">
        These buttons stand in for a real provider’s updates, delivered as signed webhooks.
      </p>
      <div className="row">
        {["delivered", "posted", "returned"].map((s) => (
          <button
            key={s}
            className="quiet small"
            onClick={() => advance(s)}
            disabled={!v.attempt?.provider_operation_id}
          >
            Report {s}
          </button>
        ))}
        <button
          className="quiet small"
          onClick={() =>
            api("POST", "/api/dev/fakepay/mode", { mode: "timeout_after_accept" }).then(() =>
              setMsg("The next submission will lose its response after the provider accepts it."),
            )
          }
        >
          Lose the next response
        </button>
      </div>
      {msg && <p className="small">{msg}</p>}
    </details>
  );
}

// Changing anything creates a new revision; any earlier approval stops applying.
function ChangeAmount({ v, onDone }: { v: IntentView; onDone: () => void }) {
  const [dollars, setDollars] = useState((v.revision.details.amount.cents / 100).toFixed(2));
  const [err, setErr] = useState<string | null>(null);
  return (
    <details>
      <summary>Change the amount</summary>
      <p className="soft small">
        {v.status === "Scheduled"
          ? "It is already approved; changing it will need a new approval."
          : ""}
      </p>
      <div className="row">
        <label>
          Amount in dollars{" "}
          <input inputMode="decimal" value={dollars} onChange={(e) => setDollars(e.target.value)} />
        </label>
        <button
          className="quiet"
          onClick={async () => {
            try {
              const details = {
                ...v.revision.details,
                amount: { currency: "USD", cents: Math.round(Number(dollars) * 100) },
              };
              await api("PUT", `/api/payment-intents/${v.id}/revisions`, {
                expectedRevision: v.revision.number,
                details,
              });
              onDone();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Save change
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </details>
  );
}

export function IntentPage({ me, id }: { me: Me; id: string }) {
  const v = useLoad<IntentView>(`/api/payment-intents/${id}`);
  if (v.error)
    return (
      <main>
        <p className="error">{v.error}</p>
      </main>
    );
  if (!v.data) return <main />;
  const d = v.data;
  const cancellable = !["Rejected", "Expired", "Canceled", "Failed", "Returned", "Posted"].includes(
    d.status,
  );
  return (
    <main>
      <p>
        <a href="#/">Back</a>
      </p>
      <Slip v={d} me={me} onDone={() => void v.reload()} />
      {["Draft", "AwaitingApproval", "Scheduled"].includes(d.status) && (
        <ChangeAmount key={d.revision.number} v={d} onDone={() => void v.reload()} />
      )}
      {cancellable && d.status !== "AwaitingApproval" && (
        <p>
          <button
            className="danger"
            onClick={() =>
              api("POST", `/api/payment-intents/${d.id}/cancel-requests`).then(() =>
                setTimeout(() => void v.reload(), 1500),
              )
            }
          >
            {["Draft", "Scheduled"].includes(d.status)
              ? "Cancel this payment"
              : "Ask the provider to cancel"}
          </button>
        </p>
      )}
      <h2>What has happened</h2>
      <ol className="timeline">
        {d.timeline.map((e) => (
          <li key={e.id}>
            <strong>{e.from_status === e.to_status ? "Note" : statusLabel(e.to_status)}</strong>{" "}
            <span className="soft small">
              {when(e.at)}, by{" "}
              {e.actor_kind === "person"
                ? e.actor_id === d.owner_id
                  ? d.owner_name
                  : e.actor_id === d.initiator_id
                    ? d.initiator_name
                    : "a person"
                : WHO[e.actor_kind]}
            </span>
            {e.reason && <div className="small">{e.reason}</div>}
          </li>
        ))}
      </ol>
      <p className="soft small">
        Statuses after “Sent to provider” come only from the provider. “Posted” means the card
        issuer confirmed it applied the payment; “Delivered” does not.
      </p>
      <Simulator v={d} onDone={() => void v.reload()} />
      <p>
        <button className="quiet" onClick={() => go("")}>
          Done
        </button>
      </p>
    </main>
  );
}

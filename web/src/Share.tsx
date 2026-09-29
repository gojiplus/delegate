import { useState } from "react";
import { api, type Me } from "./api";
import { go, useHashRoute, useLoad } from "./hooks";
import { sign } from "./passkey";

interface Resource {
  id: string;
  type: string;
  label: string;
  selected: boolean;
  shareable: boolean;
  unshareable_reason: string | null;
}
interface Proposal {
  delegateId: string;
  scopes: string[];
  resourceIds: string[];
  constraints: Record<string, Record<string, unknown>>;
  expiresAt: string | null;
}
interface Preview {
  preview: { digest: string; delegateName: string; sentences: string[] };
  options: Parameters<typeof sign>[0];
}

// Shows the grant as the delegate's abilities in plain sentences, then asks
// for the passkey over exactly that grant.
function Confirm({
  p,
  onBack,
  submit,
}: {
  p: Preview;
  onBack?: () => void;
  submit: (stepUp: unknown) => Promise<unknown>;
}) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <div className="letter">
        <p>
          <strong>{p.preview.delegateName} will be able to:</strong>
        </p>
        <ul>
          {p.preview.sentences.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <p className="soft small">
          You can pause or revoke this at any time, without asking {p.preview.delegateName}.
        </p>
      </div>
      {err && <p className="error">{err}</p>}
      <div className="row" style={{ marginTop: "1rem" }}>
        <button
          onClick={async () => {
            try {
              await submit(await sign(p.options));
              go("");
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Share with passkey
        </button>
        {onBack && (
          <button className="quiet" onClick={onBack}>
            Change
          </button>
        )}
      </div>
    </>
  );
}

function Review({ id }: { id: string }) {
  const r = useLoad<
    Preview & {
      current: { scopes: string[] } | null;
      proposed: Proposal;
      request: { note: string | null };
    }
  >(`/api/grant-requests/${id}`);
  if (r.error) return <p className="error">{r.error}</p>;
  if (!r.data) return null;
  return (
    <>
      <h1>{r.data.preview.delegateName} asked for more access</h1>
      {r.data.request.note && <p>“{r.data.request.note}”</p>}
      <p className="soft">If you agree, this replaces what they have now.</p>
      <Confirm
        p={r.data}
        submit={(stepUp) => api("POST", `/api/grant-requests/${id}/accept`, { stepUp })}
      />
      <p>
        <button
          className="danger"
          onClick={() => api("POST", `/api/grant-requests/${id}/decline`).then(() => go(""))}
        >
          Decline
        </button>
      </p>
    </>
  );
}

export function Share({ me }: { me: Me }) {
  const route = useHashRoute();
  const people = useLoad<{ id: string; display_name: string }[]>("/api/people");
  const resources = useLoad<Resource[]>("/api/resources/mine");
  const [delegateId, setDelegate] = useState("");
  const [scopes, setScopes] = useState<string[]>(["finance.balances.read"]);
  const [picked, setPicked] = useState<string[]>([]);
  const [perPayment, setPerPayment] = useState("");
  const [monthly, setMonthly] = useState("");
  const [expires, setExpires] = useState("");
  const [preview, setPreview] = useState<{ proposal: Proposal; p: Preview } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (route[1] === "request" && route[2]) {
    return (
      <main>
        <Review id={route[2]} />
      </main>
    );
  }
  if (!me.hasPasskey) {
    return (
      <main>
        <h1>Share with someone</h1>
        <p>Set up a passkey on the home page first. Sharing needs one.</p>
      </main>
    );
  }

  const shareable = resources.data?.filter((r) => r.selected && r.shareable) ?? [];
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const cents = (s: string) => (s.trim() ? Math.round(Number(s) * 100) : undefined);

  const doPreview = async () => {
    const finance: Record<string, unknown> = {};
    if (cents(perPayment)) finance.perPaymentCapCents = cents(perPayment);
    if (cents(monthly)) finance.monthlyCapCents = cents(monthly);
    const proposal: Proposal = {
      delegateId,
      scopes,
      resourceIds: picked,
      constraints: Object.keys(finance).length
        ? { finance: { ...finance, periodTimezone: "America/Los_Angeles" } }
        : {},
      expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
    };
    try {
      setErr(null);
      setPreview({ proposal, p: await api<Preview>("POST", "/api/grants/preview", proposal) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main>
      <h1>Share with someone</h1>
      {preview ? (
        <Confirm
          p={preview.p}
          onBack={() => setPreview(null)}
          submit={(stepUp) =>
            api("POST", "/api/delegation-grants", { proposal: preview.proposal, stepUp })
          }
        />
      ) : (
        <>
          <p className="soft">
            They sign in as themselves. They never see your bank passwords, and they cannot approve
            payments or change what you share.
          </p>
          <label>
            Person{" "}
            <select value={delegateId} onChange={(e) => setDelegate(e.target.value)}>
              <option value="">Choose…</option>
              {people.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>What they can do</legend>
            {me.scopes.map((s) => (
              <label key={s.id}>
                <input
                  type="checkbox"
                  checked={scopes.includes(s.id)}
                  onChange={() => setScopes(toggle(scopes, s.id))}
                />
                {s.describe.replace(/ (for|between)$/, "")}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>With which accounts and billers</legend>
            {shareable.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  checked={picked.includes(r.id)}
                  onChange={() => setPicked(toggle(picked, r.id))}
                />
                {r.label}
              </label>
            ))}
            {resources.data
              ?.filter((r) => !r.shareable)
              .map((r) => (
                <p key={r.id} className="soft small">
                  {r.label}: {r.unshareable_reason}
                </p>
              ))}
            {resources.data?.some((r) => !r.selected) && (
              <p className="soft small">
                Accounts you have not chosen to use in FamilyOps are not listed.
              </p>
            )}
          </fieldset>
          {scopes.includes("finance.payments.prepare") && (
            <fieldset>
              <legend>Limits on payments they prepare (optional)</legend>
              <label>
                Per payment, in dollars{" "}
                <input
                  inputMode="decimal"
                  value={perPayment}
                  onChange={(e) => setPerPayment(e.target.value)}
                />
              </label>
              <label>
                Per month, in dollars{" "}
                <input
                  inputMode="decimal"
                  value={monthly}
                  onChange={(e) => setMonthly(e.target.value)}
                />
              </label>
              <p className="soft small">
                You still approve every payment. Limits are a second check when it is sent.
              </p>
            </fieldset>
          )}
          <label>
            End access automatically on (optional){" "}
            <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
          {err && <p className="error">{err}</p>}
          <p>
            <button disabled={!delegateId || !scopes.length || !picked.length} onClick={doPreview}>
              Review what they will see
            </button>
          </p>
        </>
      )}
    </main>
  );
}

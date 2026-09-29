import { useState } from "react";
import {
  type Account,
  api,
  type Grant,
  type IntentSummary,
  type Me,
  usd,
  when,
  type WorkItem,
} from "./api";
import { go, useLoad } from "./hooks";
import { registerPasskey, sign } from "./passkey";
import { StatusTag } from "./Status";

interface Queue {
  workItems: WorkItem[];
  stale: {
    owner_id: string;
    owner_name: string;
    label: string;
    detail: string;
    observed_at: string | null;
  }[];
  intents: IntentSummary[];
}
interface MyResource {
  id: string;
  type: string;
  label: string;
  selected: boolean;
  shareable: boolean;
  unshareable_reason: string | null;
}

const EVIDENCE: Record<WorkItem["evidence_level"], string> = {
  provider: "Reported by the institution",
  user_confirmed: "Entered by a person",
  inferred: "Guessed from past charges",
};

function Obligation({ w, canPrepare }: { w: WorkItem; canPrepare: boolean }) {
  const [busy, setBusy] = useState(false);
  const d = w.details;
  const done = w.status === "verified_done" || w.status === "marked_done";
  return (
    <li>
      <div className="line">
        <strong>{w.title}</strong>
        <span className="amount">{w.type === "finance.obligation" ? usd(d.amountCents) : ""}</span>
      </div>
      <div className="soft small">
        {w.resource_label}
        {d.dueDate ? `, due ${d.dueDate}` : ", due date unknown"}
        {d.autopay === "on" ? ", autopay is on" : ""}
      </div>
      <div className="row small" style={{ marginTop: "0.3rem" }}>
        <span className={`tag ${w.evidence_level === "inferred" ? "held" : ""}`}>
          {EVIDENCE[w.evidence_level]}
        </span>
        <span className="soft">
          {w.source}, as of {when(w.observed_at)}
        </span>
        {w.status === "verified_done" && (
          <span className="tag ok">Paid: confirmed by the card issuer</span>
        )}
        {w.status === "marked_done" && (
          <span className="tag">Marked done by a person, not verified</span>
        )}
        {w.completion?.kind === "reopened" && (
          <span className="tag stop">Reopened: the payment came back</span>
        )}
      </div>
      {!done && (
        <div className="row" style={{ marginTop: "0.5rem" }}>
          {canPrepare && w.type === "finance.obligation" && (
            <button className="quiet" onClick={() => go(`prepare/${w.owner_id}/${w.id}`)}>
              Prepare a payment
            </button>
          )}
          <button
            className="quiet"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api("PATCH", `/api/work-items/${w.id}`, { status: "marked_done" });
              window.location.reload();
            }}
          >
            Mark done
          </button>
        </div>
      )}
    </li>
  );
}

function TrustedContact() {
  const current = useLoad<{ name: string; email: string } | null>("/api/trusted-contact");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <p className="soft">
        Someone who does not help with your accounts, told when anyone gets access or a payment
        someone else prepared is approved.
      </p>
      {current.data ? (
        <p>
          <strong>{current.data.name}</strong> ({current.data.email})
        </p>
      ) : (
        <p className="soft">No trusted contact yet.</p>
      )}
      <div className="row">
        <label>
          Name <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button
          className="quiet"
          disabled={!name || !email}
          onClick={async () => {
            try {
              setErr(null);
              const contact = { name, email };
              const options = await api<Parameters<typeof sign>[0]>(
                "POST",
                "/api/trusted-contact/options",
                contact,
              );
              await api("POST", "/api/trusted-contact", { contact, stepUp: await sign(options) });
              window.location.reload();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          {current.data ? "Change with passkey" : "Save with passkey"}
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </>
  );
}

function PaymentsList({ intents, me }: { intents: IntentSummary[]; me: Me }) {
  if (!intents.length) return <p className="soft">No payments yet.</p>;
  return (
    <ul className="plain">
      {intents.map((i) => (
        <li key={i.id} className="line">
          <a href={`#/intent/${i.id}`}>
            {i.initiator_id === me.id ? "Payment you prepared" : "Payment prepared for you"}
          </a>
          <span className="row">
            <StatusTag status={i.status} held={i.hold_reason} />
            <span className="soft small">{when(i.updated_at)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function GrantLine({ g, me, scopes }: { g: Grant; me: Me; scopes: Me["scopes"] }) {
  const set = async (status: string) => {
    if (
      status === "revoked" &&
      !window.confirm(
        `Stop all of ${g.delegate_name}'s access? Payments already sent cannot be recalled.`,
      )
    )
      return;
    // Resuming restores authority, so it is signed with the passkey like a new grant.
    const stepUp =
      status === "active"
        ? await sign(
            await api<Parameters<typeof sign>[0]>(
              "POST",
              `/api/delegation-grants/${g.id}/resume-options`,
            ),
          )
        : undefined;
    const r = await api<{ inFlight: string[] }>("POST", `/api/delegation-grants/${g.id}/status`, {
      status,
      stepUp,
    });
    if (r.inFlight.length)
      window.alert(
        `${r.inFlight.length} payment(s) were already sent. Cancellation has been requested; check each one for the outcome.`,
      );
    window.location.reload();
  };
  const f = g.constraints.finance;
  return (
    <li>
      <div className="line">
        <strong>{g.grantor_id === me.id ? g.delegate_name : g.grantor_name}</strong>
        {g.status === "paused" ? (
          <span className="tag held">Paused</span>
        ) : (
          <span className="tag ok">Active</span>
        )}
      </div>
      <ul className="small">
        {g.scopes.map((s) => (
          <li key={s}>
            {scopes.find((x) => x.id === s)?.describe}: {g.resources.map((r) => r.label).join(", ")}
          </li>
        ))}
        {f?.perPaymentCapCents && <li>At most {usd(f.perPaymentCapCents)} per payment</li>}
        {f?.monthlyCapCents && <li>At most {usd(f.monthlyCapCents)} a month</li>}
        <li>{g.expires_at ? `Ends ${when(g.expires_at)}` : "Until revoked"}</li>
      </ul>
      {g.grantor_id === me.id && (
        <div className="row">
          {g.status === "active" ? (
            <button className="quiet" onClick={() => set("paused")}>
              Pause
            </button>
          ) : (
            <button className="quiet" onClick={() => set("active")}>
              Resume with passkey
            </button>
          )}
          <button className="danger" onClick={() => set("revoked")}>
            Revoke
          </button>
        </div>
      )}
    </li>
  );
}

export function Home({ me, onMeChange }: { me: Me; onMeChange: () => void }) {
  const accounts = useLoad<{
    accounts: Account[];
    totals: { ownerId: string; knownCents: number; unknownCount: number }[];
  }>("/api/accounts");
  const mine = useLoad<MyResource[]>("/api/resources/mine");
  const insts = useLoad<{ id: string; name: string }[]>("/api/institutions");
  const grants = useLoad<Grant[]>("/api/grants");
  const requests =
    useLoad<{ id: string; delegate_name: string; scopes: string[]; note: string | null }[]>(
      "/api/grant-requests",
    );
  const queue = useLoad<Queue>("/api/queue");
  const notices =
    useLoad<{ id: string; kind: string; message: string; created_at: string }[]>(
      "/api/notifications",
    );
  const [err, setErr] = useState<string | null>(null);

  const act = async (f: () => Promise<unknown>) => {
    try {
      setErr(null);
      await f();
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (me.isSupport) {
    return (
      <main>
        <h1>Support</h1>
        <p>
          <a href="#/support">Open the payment exception view</a>
        </p>
      </main>
    );
  }

  const myAccounts = mine.data?.filter((r) => r.type === "finance.account") ?? [];
  const connected = new Set(
    accounts.data?.accounts.filter((a) => a.owner_id === me.id).map((a) => a.institution_id),
  );
  const waiting =
    queue.data?.intents.filter((i) => i.owner_id === me.id && i.status === "AwaitingApproval") ??
    [];
  const myWork = queue.data?.workItems.filter((w) => w.owner_id === me.id) ?? [];
  const given = grants.data?.filter((g) => g.grantor_id === me.id) ?? [];
  const received = grants.data?.filter((g) => g.delegate_id === me.id) ?? [];

  return (
    <main>
      <h1>
        {waiting.length
          ? waiting.length === 1
            ? "A payment needs your decision"
            : `${waiting.length} payments need your decision`
          : `Hello, ${me.displayName.split(" ")[0]}`}
      </h1>
      {err && <p className="error">{err}</p>}

      {!me.hasPasskey && (
        <div className="notice">
          <p>
            <strong>Set up a passkey.</strong> You need one to share access or approve a payment. It
            stays on this device; no one else, including people who help you, can use it.
          </p>
          <button onClick={() => act(registerPasskey).then(onMeChange)}>Set up a passkey</button>
        </div>
      )}
      {me.freeze && (
        <div className="notice stop">
          <p>
            <strong>Payments are stopped</strong> ({me.freeze.reason}). Nothing approved will be
            sent until you resume.
          </p>
          <button
            onClick={() =>
              act(async () => {
                const options = await api<Parameters<typeof sign>[0]>(
                  "POST",
                  "/api/unfreeze/options",
                );
                await api("POST", "/api/unfreeze", { stepUp: await sign(options) });
              })
            }
          >
            Resume with passkey
          </button>
        </div>
      )}

      {waiting.length > 0 && (
        <ul className="plain">
          {waiting.map((i) => (
            <li key={i.id} className="line">
              <span>Payment waiting for your approval</span>
              <a className="button" href={`#/intent/${i.id}`}>
                Review
              </a>
            </li>
          ))}
        </ul>
      )}

      {(requests.data?.length ?? 0) > 0 && (
        <>
          <h2>Requests for more access</h2>
          <ul className="plain">
            {requests.data!.map((r) => (
              <li key={r.id} className="line">
                <span>
                  {r.delegate_name} asked for more access{r.note ? `: “${r.note}”` : ""}
                </span>
                <a className="button" href={`#/share/request/${r.id}`}>
                  Review
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      {received.map((g) => {
        const theirs = queue.data?.workItems.filter((w) => w.owner_id === g.grantor_id) ?? [];
        const stale = queue.data?.stale.filter((s) => s.owner_id === g.grantor_id) ?? [];
        const total = accounts.data?.totals.find((t) => t.ownerId === g.grantor_id);
        return (
          <section key={g.id}>
            <h2>Helping {g.grantor_name}</h2>
            {g.status === "paused" && (
              <p className="notice">{g.grantor_name} has paused your access.</p>
            )}
            {total && (
              <p className="soft">
                Available in accounts shared with you: <strong>{usd(total.knownCents)}</strong>
                {total.unknownCount
                  ? `, plus ${total.unknownCount} account(s) with unknown balance`
                  : ""}
                .
              </p>
            )}
            {stale.map((s) => (
              <p key={s.label} className="notice">
                {s.label}: {s.detail}. Only {g.grantor_name} can reconnect it.
              </p>
            ))}
            <h3>Bills and tasks</h3>
            {theirs.length ? (
              <ul className="plain">
                {theirs.map((w) => (
                  <Obligation
                    key={w.id}
                    w={w}
                    canPrepare={g.scopes.includes("finance.payments.prepare")}
                  />
                ))}
              </ul>
            ) : (
              <p className="soft">Nothing is shared with you here yet.</p>
            )}
            {g.scopes.includes("finance.payments.prepare") && (
              <button className="quiet" onClick={() => go(`prepare/${g.grantor_id}`)}>
                Prepare a payment for {g.grantor_name.split(" ")[0]}
              </button>
            )}
          </section>
        );
      })}

      <h2>Your bills and tasks</h2>
      {myWork.length ? (
        <ul className="plain">
          {myWork.map((w) => (
            <Obligation key={w.id} w={w} canPrepare />
          ))}
        </ul>
      ) : (
        <p className="soft">Connect an account below to bring in bills.</p>
      )}

      <h2>Payments</h2>
      <PaymentsList intents={queue.data?.intents ?? []} me={me} />

      <h2>Your accounts</h2>
      <p className="soft">
        New accounts stay private until you choose to use them here. Choosing an account does not
        share it with anyone.
      </p>
      <ul className="plain">
        {myAccounts.map((r) => {
          const a = accounts.data?.accounts.find((x) => x.id === r.id);
          return (
            <li key={r.id}>
              <div className="line">
                <strong>{r.label}</strong>
                <span className="amount">
                  {a?.balance ? usd(a.balance.availableCents ?? a.balance.currentCents) : ""}
                </span>
              </div>
              <div className="row small">
                {a?.balance && (
                  <span className="soft">
                    Balance as of {when(a.balance.observedAt)} ({a.balance.source})
                  </span>
                )}
                {a?.connection_status === "needs_reconnect" && (
                  <button
                    className="quiet small"
                    onClick={() =>
                      act(() => api("POST", `/api/connections/${a.connection_id}/reconnect`))
                    }
                  >
                    Reconnect
                  </button>
                )}
                {!r.shareable && (
                  <span className="tag held">Can’t be shared: {r.unshareable_reason}</span>
                )}
                {r.selected ? (
                  <button
                    className="quiet small"
                    onClick={() =>
                      act(() =>
                        api("POST", "/api/accounts/selection", {
                          resourceIds: [r.id],
                          selected: false,
                        }),
                      )
                    }
                  >
                    Stop using here
                  </button>
                ) : (
                  <button
                    className="small"
                    onClick={() =>
                      act(() =>
                        api("POST", "/api/accounts/selection", {
                          resourceIds: [r.id],
                          selected: true,
                        }),
                      )
                    }
                  >
                    Use in the app
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {(insts.data?.filter((i) => !connected.has(i.id)).length ?? 0) > 0 && (
        <div className="row" style={{ marginTop: "1rem" }}>
          {insts
            .data!.filter((i) => !connected.has(i.id))
            .map((i) => (
              <button
                key={i.id}
                className="quiet"
                onClick={() =>
                  act(() => api("POST", "/api/connection-sessions", { institutionId: i.id }))
                }
              >
                Connect {i.name} (simulated)
              </button>
            ))}
        </div>
      )}

      <h2>Who can help you</h2>
      {given.length ? (
        <ul className="plain">
          {given.map((g) => (
            <GrantLine key={g.id} g={g} me={me} scopes={me.scopes} />
          ))}
        </ul>
      ) : (
        <p className="soft">No one has access to anything of yours.</p>
      )}
      <a className="button" href="#/share">
        Share with someone
      </a>

      {received.length > 0 && (
        <>
          <h2>What others have shared with you</h2>
          <ul className="plain">
            {received.map((g) => (
              <GrantLine key={g.id} g={g} me={me} scopes={me.scopes} />
            ))}
          </ul>
        </>
      )}

      <h2>Notices</h2>
      <p className="soft">
        In the pilot these arrive by email or text, outside this app. Here they are listed so you
        can see what would be sent.
      </p>
      {notices.data?.length ? (
        <ul className="plain">
          {notices.data.slice(0, 8).map((n) => (
            <li key={n.id}>
              <div>{n.message}</div>
              <div className="soft small">{when(n.created_at)}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="soft">Nothing yet.</p>
      )}

      <h2>Trusted contact</h2>
      <TrustedContact />

      <h2>Your records</h2>
      <div className="row">
        <a href="/api/audit/export">Download everything recorded about your accounts</a>
        <button className="quiet" onClick={() => act(() => api("POST", "/api/sessions/end-all"))}>
          Sign out everywhere
        </button>
        {!me.freeze && (
          <button
            className="danger"
            onClick={() => act(() => api("POST", "/api/freeze", { reason: "stopped by you" }))}
          >
            Stop all payments
          </button>
        )}
      </div>
    </main>
  );
}

import { api, when } from "./api";
import { useLoad } from "./hooks";
import { StatusTag } from "./Status";

interface Overview {
  intents: {
    id: string;
    owner_id: string;
    type: string;
    status: string;
    hold_reason: string | null;
    status_reason: string | null;
    updated_at: string;
    provider_operation_id: string | null;
    raw_status: string | null;
  }[];
  freezes: { owner_id: string; reason: string }[];
  control: { key: string; value: unknown }[];
}

export function Support() {
  const o = useLoad<Overview>("/api/support/overview");
  if (o.error)
    return (
      <main>
        <p className="error">{o.error}</p>
      </main>
    );
  if (!o.data) return <main />;
  const enabled = o.data.control.find((c) => c.key === "submissions_enabled")?.value !== false;
  return (
    <main>
      <h1>Payment exceptions</h1>
      <p className="soft">
        You can see states and provider references, not amounts or accounts. You can stop
        submissions; you cannot approve or restart anyone’s payments.
      </p>
      <p>
        New submissions are <strong>{enabled ? "on" : "paused"}</strong>.{" "}
        <button
          className={enabled ? "danger" : ""}
          onClick={() =>
            api("POST", "/api/support/submissions", { enabled: !enabled }).then(
              () => void o.reload(),
            )
          }
        >
          {enabled ? "Pause all new submissions" : "Resume submissions"}
        </button>
      </p>
      <table>
        <thead>
          <tr>
            <th>Payment</th>
            <th>Owner</th>
            <th>State</th>
            <th>Provider</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {o.data.intents.map((i) => (
            <tr key={i.id}>
              <td>{i.id}</td>
              <td>{i.owner_id}</td>
              <td>
                <StatusTag status={i.status} held={i.hold_reason} />
                {i.status_reason && <div className="small">{i.status_reason}</div>}
              </td>
              <td>
                {i.provider_operation_id ? `${i.provider_operation_id} (${i.raw_status})` : "none"}
              </td>
              <td>{when(i.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

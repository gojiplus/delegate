const LABEL: Record<string, string> = {
  Draft: "Being prepared",
  AwaitingApproval: "Awaiting approval",
  Scheduled: "Approved, scheduled",
  Dispatching: "Sending",
  Reconciling: "Checking with provider",
  Submitted: "Sent to provider",
  Delivered: "Delivered to card issuer",
  Posted: "Posted by card issuer",
  Returned: "Returned",
  Rejected: "Declined by owner",
  Expired: "Expired",
  Canceled: "Canceled",
  Failed: "Failed",
};
const TONE: Record<string, string> = {
  Posted: "ok",
  Returned: "stop",
  Rejected: "stop",
  Expired: "stop",
  Canceled: "stop",
  Failed: "stop",
  Reconciling: "held",
  AwaitingApproval: "held",
};

export function statusLabel(s: string) {
  return LABEL[s] ?? s;
}

export function StatusTag({ status, held }: { status: string; held?: string | null }) {
  if (held) return <span className="tag held">Held: {held}</span>;
  return <span className={`tag ${TONE[status] ?? ""}`}>{statusLabel(status)}</span>;
}

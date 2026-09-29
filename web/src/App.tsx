import { useEffect, useState } from "react";
import { api, type Me } from "./api";
import { useHashRoute, useLoad } from "./hooks";
import { Home } from "./Home";
import { IntentPage } from "./Intent";
import { Prepare } from "./Prepare";
import { Share } from "./Share";
import { Support } from "./Support";

const ROLES: Record<string, string> = {
  p_maria: "Owns checking, savings, a joint account and two cards. Nothing shared yet.",
  p_sam: "Maria's son. Lee's spouse: Lee already shares with him.",
  p_lee: "Sam's spouse. Shares everything with Sam; sees Sam's checking.",
  p_tom: "Maria's husband. Has no access to anything of hers.",
  p_priya: "Runs a small business; her bookkeeper Omar can prepare payments.",
  p_omar: "Priya's bookkeeper, with a $5,000 per-payment limit.",
  p_support: "Support staff: can see payment states and pause submissions, never approve.",
};

function Login({ onDone }: { onDone: () => void }) {
  const people = useLoad<{ id: string; display_name: string }[]>("/api/dev/people");
  return (
    <main>
      <h1>Choose who you are</h1>
      <p className="soft">
        In the pilot, each person signs in with their own account. Here you pick a fictional person
        to see the app from their side.
      </p>
      <ul className="plain">
        {people.data?.map((p) => (
          <li key={p.id} className="line">
            <div>
              <strong>{p.display_name}</strong>
              <div className="soft small">{ROLES[p.id]}</div>
            </div>
            <button
              className="quiet"
              onClick={async () => {
                await api("POST", "/api/dev/login", { personId: p.id });
                onDone();
              }}
            >
              Continue as {p.display_name.split(" ")[0]}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

export function App() {
  const route = useHashRoute();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const loadMe = async () => {
    try {
      setMe(await api<Me>("GET", "/api/me"));
    } catch {
      setMe(null);
    }
  };
  useEffect(() => {
    api<Me>("GET", "/api/me").then(setMe, () => setMe(null));
  }, []);

  const [page, ...rest] = route;
  let body;
  if (me === undefined) body = <main />;
  else if (me === null) body = <Login onDone={loadMe} />;
  else if (page === "share") body = <Share me={me} />;
  else if (page === "prepare")
    body = <Prepare me={me} ownerId={rest[0] ?? me.id} workItemId={rest[1] ?? null} />;
  else if (page === "intent" && rest[0]) body = <IntentPage me={me} id={rest[0]} />;
  else if (page === "support") body = <Support />;
  else body = <Home me={me} onMeChange={loadMe} />;

  return (
    <>
      <div className="sim" role="note">
        Demonstrator: accounts and payments are simulated. No bank is connected and no money moves.
      </div>
      <header className="top">
        <a className="brand" href="#/">
          FamilyOps
        </a>
        {me && (
          <span className="who">
            Signed in as {me.displayName}{" "}
            <button
              className="quiet small"
              onClick={async () => {
                await api("POST", "/api/logout");
                window.location.hash = "#/";
                setMe(null);
              }}
            >
              Switch person
            </button>
          </span>
        )}
      </header>
      {body}
    </>
  );
}

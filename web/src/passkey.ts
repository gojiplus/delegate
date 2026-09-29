import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api";

export async function registerPasskey() {
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
    "POST",
    "/api/passkeys/options",
  );
  const response = await startRegistration({ optionsJSON });
  await api("POST", "/api/passkeys", response);
}

// Signs one server-issued challenge. The server bound that challenge to the
// exact grant or payment on screen; the browser only proves presence.
export function sign(optionsJSON: Parameters<typeof startAuthentication>[0]["optionsJSON"]) {
  return startAuthentication({ optionsJSON });
}

import { mkdirSync } from "node:fs";
import { type BrowserContext, chromium, type Page } from "@playwright/test";

// Drives the running demo (make dev on a freshly seeded database) through the
// core flow in a real browser, with a virtual passkey per person, and saves
// screenshots to docs/screenshots. Run: npx tsx src/scripts/walkthrough.ts

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const OUT = "docs/screenshots";
mkdirSync(OUT, { recursive: true });

async function person(ctx: BrowserContext, id: string): Promise<Page> {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(BASE);
  await page.request.post(`${BASE}/api/dev/login`, { data: { personId: id } });
  await page.goto(BASE);
  return page;
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

const browser = await chromium.launch();
const opts = { viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 };
const mariaCtx = await browser.newContext(opts);
const samCtx = await browser.newContext(opts);

const maria = await person(mariaCtx, "p_maria");
await maria.getByRole("button", { name: "Set up a passkey" }).click();
await maria.getByText("Set up a passkey.").waitFor({ state: "detached" });
for (const label of [
  "Harbor Checking ••3821",
  "Harbor Savings ••5510",
  "Summit Visa ••9042",
  "Northstar Mastercard ••6120",
]) {
  await maria
    .locator("li", { hasText: label })
    .getByRole("button", { name: "Use in FamilyOps" })
    .click();
  await maria
    .locator("li", { hasText: label })
    .getByRole("button", { name: "Stop using here" })
    .waitFor();
}
await shot(maria, "01-owner-home");

await maria.goto(`${BASE}/#/share`);
await maria.getByLabel("Person").selectOption("p_sam");
await maria.getByLabel("Track bills and tasks, add notes and mark them done").check();
await maria.getByLabel("Prepare payments for you to approve (never send them)").check();
for (const label of ["Harbor Checking ••3821", "Harbor Savings ••5510", "Summit Visa ••9042"])
  await maria.getByLabel(label).check();
await maria.getByLabel("Per payment, in dollars").fill("1000");
await maria.getByLabel("Per month, in dollars").fill("1500");
await shot(maria, "02-share-form");
await maria.getByRole("button", { name: "Review what they will see" }).click();
await maria.getByText("will be able to:").waitFor();
await shot(maria, "03-share-preview");
await maria.getByRole("button", { name: "Share with passkey" }).click();
await maria.getByRole("heading", { name: "Who can help you" }).waitFor();

const sam = await person(samCtx, "p_sam");
await sam.getByRole("heading", { name: "Helping Maria Alvarez" }).waitFor();
await shot(sam, "04-helper-queue");

await sam
  .locator("section", { hasText: "Helping Maria Alvarez" })
  .locator("li", { hasText: "Summit Visa statement" })
  .getByRole("button", { name: "Prepare a payment" })
  .click();
await sam.getByText("Can be sent from FamilyOps").waitFor();
await shot(sam, "05-prepare");
await sam.getByLabel("Pay to").selectOption({ label: "Harbor Savings ••5510" });
await sam.getByText("Not available.").waitFor();
await shot(sam, "06-honest-capability");
await sam.getByLabel("Pay to").selectOption({ label: "Summit Visa ••9042" });
await sam.getByText("Can be sent from FamilyOps").waitFor();
await sam.getByRole("button", { name: "Send to Maria Alvarez for approval" }).click();
await sam.getByText("Awaiting approval").first().waitFor();

await maria.goto(BASE);
await maria.getByRole("heading", { name: "A payment needs your decision" }).waitFor();
await shot(maria, "07-owner-needs-decision");
await maria.getByRole("link", { name: "Review" }).first().click();
await maria.getByRole("button", { name: "Approve with passkey" }).waitFor();
await shot(maria, "08-approval-slip");
await maria.getByRole("button", { name: "Approve with passkey" }).click();
// The worker picks up the dispatch job within its poll interval.
await maria.waitForTimeout(3000);
await maria.reload();
await shot(maria, "09-sent");
await maria.getByText("Simulate the payment provider").click();
await maria.getByRole("button", { name: "Report delivered" }).click();
await maria.waitForTimeout(3000);
await maria.reload();
await maria.getByText("Simulate the payment provider").click();
await maria.getByRole("button", { name: "Report posted" }).click();
await maria.waitForTimeout(3000);
await maria.reload();
await shot(maria, "10-timeline-posted");

await maria.goto(BASE);
maria.once("dialog", (d) => void d.accept());
await maria
  .locator("li", { hasText: "Sam Alvarez" })
  .getByRole("button", { name: "Revoke" })
  .click();
await maria.getByText("No one has access to anything of yours.").waitFor();
await sam.reload();
await sam.waitForTimeout(500);
await shot(sam, "11-helper-after-revoke");

await browser.close();
console.log(`screenshots in ${OUT}`);

// Simulated institutions and data. Every name here is fictional. Nothing in
// R0 talks to a bank; these fixtures stand where Plaid responses will in R1.

export interface FixtureAccount {
  providerAccountId: string;
  // Present when the institution exposes a stable identity across relinks
  // (as some do via Plaid's persistent_account_id); absent otherwise.
  persistentAccountId: string | null;
  name: string;
  mask: string;
  kind: "depository" | "credit";
  subtype: string;
  ownership: "sole" | "joint";
  currentCents: number | null;
  availableCents: number | null;
  transactions: {
    ref: string;
    daysAgo: number;
    amountCents: number;
    description: string;
    pending?: boolean;
  }[];
  liability?: {
    statementBalanceCents: number | null;
    minimumDueCents: number | null;
    dueInDays: number | null;
    autopay: "on" | "off" | "unknown";
  };
}

export interface FixtureInstitution {
  id: string;
  name: string;
  // Only card issuers listed here accept simulated creditor payments.
  acceptsCreditorPayments: boolean;
}

export const INSTITUTIONS: FixtureInstitution[] = [
  { id: "harbor", name: "Harbor Bank", acceptsCreditorPayments: false },
  { id: "lakeside", name: "Lakeside Credit Union", acceptsCreditorPayments: false },
  { id: "summit", name: "Summit Card", acceptsCreditorPayments: true },
  { id: "northstar", name: "Northstar Card", acceptsCreditorPayments: false },
];

const monthly = (desc: string, cents: number, months = 4, offset = 3) =>
  Array.from({ length: months }, (_, n) => ({
    ref: `${desc.toLowerCase().replace(/\W+/g, "-")}-${n}`,
    daysAgo: offset + 30 * n,
    amountCents: -cents - (n % 2) * 137,
    description: desc,
  }));

// Keyed by fixture login email, then institution.
export const FIXTURE_DATA: Record<string, Record<string, FixtureAccount[]>> = {
  "maria@example.test": {
    harbor: [
      {
        providerAccountId: "hb-maria-chk",
        persistentAccountId: "hb-persist-3821",
        name: "Harbor Checking",
        mask: "3821",
        kind: "depository",
        subtype: "checking",
        ownership: "sole",
        currentCents: 612_430,
        availableCents: 598_210,
        transactions: [
          ...monthly("CITY WATER DEPT", 6_412),
          { ref: "ss-0", daysAgo: 5, amountCents: 184_200, description: "SOCIAL SECURITY" },
          { ref: "ss-1", daysAgo: 35, amountCents: 184_200, description: "SOCIAL SECURITY" },
          {
            ref: "pharm-0",
            daysAgo: 2,
            amountCents: -2_315,
            description: "CORNER PHARMACY",
            pending: true,
          },
          { ref: "grocer-0", daysAgo: 4, amountCents: -8_744, description: "GREENLEAF MARKET" },
        ],
      },
      {
        providerAccountId: "hb-maria-sav",
        persistentAccountId: null,
        name: "Harbor Savings",
        mask: "5510",
        kind: "depository",
        subtype: "savings",
        ownership: "sole",
        currentCents: 2_210_000,
        availableCents: 2_210_000,
        transactions: [
          { ref: "int-0", daysAgo: 8, amountCents: 1_120, description: "INTEREST PAID" },
        ],
      },
    ],
    lakeside: [
      {
        providerAccountId: "lk-maria-joint",
        persistentAccountId: "lk-persist-7744",
        name: "Lakeside Joint Checking",
        mask: "7744",
        kind: "depository",
        subtype: "checking",
        ownership: "joint",
        currentCents: 143_300,
        availableCents: 143_300,
        transactions: [
          { ref: "elec-0", daysAgo: 9, amountCents: -11_260, description: "VALLEY ELECTRIC" },
        ],
      },
    ],
    summit: [
      {
        providerAccountId: "sm-maria-visa",
        persistentAccountId: "sm-persist-9042",
        name: "Summit Visa",
        mask: "9042",
        kind: "credit",
        subtype: "credit card",
        ownership: "sole",
        currentCents: 42_817,
        availableCents: null,
        transactions: [
          { ref: "pay-0", daysAgo: 27, amountCents: 39_120, description: "PAYMENT THANK YOU" },
        ],
        liability: {
          statementBalanceCents: 42_817,
          minimumDueCents: 3_500,
          dueInDays: 12,
          autopay: "off",
        },
      },
    ],
    northstar: [
      {
        providerAccountId: "ns-maria-mc",
        persistentAccountId: null,
        name: "Northstar Mastercard",
        mask: "6120",
        kind: "credit",
        subtype: "credit card",
        ownership: "sole",
        currentCents: 9_950,
        availableCents: null,
        transactions: [],
        // The provider does not report a statement amount: it must stay unknown, not $0.
        liability: {
          statementBalanceCents: null,
          minimumDueCents: null,
          dueInDays: 20,
          autopay: "unknown",
        },
      },
    ],
  },
  "lee@example.test": {
    harbor: [
      {
        providerAccountId: "hb-lee-chk",
        persistentAccountId: "hb-persist-1200",
        name: "Harbor Checking",
        mask: "1200",
        kind: "depository",
        subtype: "checking",
        ownership: "sole",
        currentCents: 381_000,
        availableCents: 377_500,
        transactions: [...monthly("METRO INTERNET", 7_999, 3, 6)],
      },
    ],
    summit: [
      {
        providerAccountId: "sm-lee-visa",
        persistentAccountId: "sm-persist-3300",
        name: "Summit Visa",
        mask: "3300",
        kind: "credit",
        subtype: "credit card",
        ownership: "sole",
        currentCents: 120_455,
        availableCents: null,
        transactions: [
          { ref: "pay-0", daysAgo: 3, amountCents: 98_000, description: "AUTOPAY PAYMENT" },
        ],
        liability: {
          statementBalanceCents: 120_455,
          minimumDueCents: 4_000,
          dueInDays: 9,
          autopay: "on",
        },
      },
    ],
  },
  "sam@example.test": {
    harbor: [
      {
        providerAccountId: "hb-sam-chk",
        persistentAccountId: "hb-persist-2288",
        name: "Harbor Checking",
        mask: "2288",
        kind: "depository",
        subtype: "checking",
        ownership: "sole",
        currentCents: 254_120,
        availableCents: 250_000,
        transactions: [],
      },
    ],
  },
  "priya@example.test": {
    harbor: [
      {
        providerAccountId: "hb-priya-biz",
        persistentAccountId: "hb-persist-4410",
        name: "Shah Ceramics Business Checking",
        mask: "4410",
        kind: "depository",
        subtype: "checking",
        ownership: "sole",
        currentCents: 1_845_000,
        availableCents: 1_802_300,
        transactions: [...monthly("KILN SUPPLY CO", 45_000, 3, 10)],
      },
    ],
    summit: [
      {
        providerAccountId: "sm-priya-biz",
        persistentAccountId: "sm-persist-8801",
        name: "Summit Business Card",
        mask: "8801",
        kind: "credit",
        subtype: "credit card",
        ownership: "sole",
        currentCents: 310_220,
        availableCents: null,
        transactions: [],
        liability: {
          statementBalanceCents: 310_220,
          minimumDueCents: 9_000,
          dueInDays: 15,
          autopay: "off",
        },
      },
    ],
  },
};

export const FIXTURE_PEOPLE = [
  { id: "p_maria", display_name: "Maria Alvarez", email: "maria@example.test" },
  { id: "p_tom", display_name: "Tom Alvarez", email: "tom@example.test" },
  { id: "p_sam", display_name: "Sam Alvarez", email: "sam@example.test" },
  { id: "p_lee", display_name: "Lee Park", email: "lee@example.test" },
  { id: "p_priya", display_name: "Priya Shah", email: "priya@example.test" },
  { id: "p_omar", display_name: "Omar Haddad", email: "omar@example.test" },
  { id: "p_support", display_name: "Riley (Support)", email: "support@example.test" },
];

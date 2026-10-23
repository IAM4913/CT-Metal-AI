// Seed data for scripts/seed.ts: the broker, the two demo customers, and the
// example vendors from PRD section 14. Pure data, no I/O, so Vitest can check
// it (scripts/seed-data.test.ts) without a database.
//
// Everything here is a placeholder for Caleb to correct in the UI: vendor
// branch cities, terms, and freight defaults are plausible guesses from the
// discovery call, contact names are invented, and every email is @example.com.
// Each vendor, branch, and contact note carries EXAMPLE_NOTE so the demo makes
// that visible. Do not put real phone numbers or addresses in this file.
//
// Enum fields are typed against src/lib/db/enums.ts so a misspelled category or
// freight default fails `tsc` instead of failing the insert.

import type { FreightDefault, MaterialCategory, VendorType } from "@/lib/db/enums";

/** PRD section 14: one broker for Phase 1, name to be set with Caleb. */
export const SEED_BROKER_NAME = "Caleb's company (set name)";

/** Marker required on every vendor-side note (PRD AC-5.2). */
export const EXAMPLE_NOTE = "example from discovery call, verify";

export type SeedCustomerContact = {
  name: string;
  email: string;
  phone: string;
};

export type SeedCustomer = {
  name: string;
  short_name: string;
  email_domain: string;
  notes: string;
  contacts: SeedCustomerContact[];
};

export type SeedContact = {
  name: string;
  /** Always an @example.com address. */
  email: string;
  phone: string | null;
  is_primary: boolean;
  notes: string;
};

export type SeedBranch = {
  name: string;
  city: string;
  state: string;
  region: string | null;
  preferred: boolean;
  payment_terms: string | null;
  early_pay_pct: number | null;
  early_pay_days: number | null;
  freight_default: FreightDefault;
  notes: string;
  contacts: SeedContact[];
  capabilities: MaterialCategory[];
};

export type SeedVendor = {
  name: string;
  vendor_type: VendorType;
  website: string | null;
  notes: string;
  branches: SeedBranch[];
};

// ---------------------------------------------------------------------------
// Customers (the senders of the request fixtures under fixtures/requests/)
// ---------------------------------------------------------------------------

export const SEED_CUSTOMERS: SeedCustomer[] = [
  {
    name: "Lone Star Fabrication",
    short_name: "Lone Star",
    email_domain: "lonestarfab.example.com",
    notes: "example customer for the demo fixtures (mixed-list.eml), replace with a real account",
    contacts: [
      {
        name: "Dale Hutchins",
        email: "dale@lonestarfab.example.com",
        phone: "(817) 555-0142",
      },
    ],
  },
  {
    name: "Brazos Valley Fabricators",
    short_name: "Brazos",
    email_domain: "brazosfab.example.com",
    notes: "example customer for the demo fixtures (pdf-list.eml), replace with a real account",
    contacts: [
      {
        name: "Rita Alvarez",
        email: "rita@brazosfab.example.com",
        phone: "(979) 555-0188",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Vendors (PRD section 14)
// ---------------------------------------------------------------------------

// Shorthands so the terms read the same on every branch that uses them.
const NET_30 = "Net 30";
const NET_30_EARLY_1_10 = "Net 30, 1% 10 days";

function contact(
  name: string,
  email: string,
  phone: string | null,
  is_primary: boolean,
  extra?: string,
): SeedContact {
  return {
    name,
    email,
    phone,
    is_primary,
    notes: extra ? `${EXAMPLE_NOTE}; ${extra}` : EXAMPLE_NOTE,
  };
}

export const SEED_VENDORS: SeedVendor[] = [
  // ---- Mills --------------------------------------------------------------
  {
    name: "Gerdau",
    vendor_type: "mill",
    website: "https://www.gerdau.com",
    notes: `${EXAMPLE_NOTE}; structural mill, long products`,
    branches: [
      {
        name: "Gerdau Midlothian",
        city: "Midlothian",
        state: "TX",
        region: "DFW",
        preferred: false,
        payment_terms: NET_30,
        early_pay_pct: null,
        early_pay_days: null,
        freight_default: "fob",
        notes: `${EXAMPLE_NOTE}; mill ships FOB, truckload quantities`,
        contacts: [
          contact("Tom Barrera", "tom.barrera@example.com", "(972) 555-0101", true, "inside sales"),
        ],
        capabilities: [
          "w_beam",
          "s_beam",
          "channel",
          "angle",
          "flat_bar",
          "round_bar",
          "square_bar",
          "rebar",
        ],
      },
    ],
  },
  {
    name: "Bull Moose",
    vendor_type: "mill",
    website: "https://www.bullmoosetube.com",
    notes: `${EXAMPLE_NOTE}; tubing mill`,
    branches: [
      {
        name: "Bull Moose Gerald",
        city: "Gerald",
        state: "MO",
        region: "Midwest",
        preferred: true,
        payment_terms: NET_30,
        early_pay_pct: null,
        early_pay_days: null,
        freight_default: "fob",
        notes: `${EXAMPLE_NOTE}; HSS mill, rolling schedule by size`,
        contacts: [
          contact("Janelle Prather", "janelle.prather@example.com", "(573) 555-0120", true),
        ],
        capabilities: ["hss_square", "hss_rectangular", "hss_round"],
      },
      {
        name: "Bull Moose Sinton",
        city: "Sinton",
        state: "TX",
        region: "Gulf Coast",
        preferred: false,
        payment_terms: NET_30,
        early_pay_pct: null,
        early_pay_days: null,
        freight_default: "fob",
        notes: `${EXAMPLE_NOTE}; Texas HSS mill, confirm which sizes roll here`,
        contacts: [contact("Luis Ortega", "luis.ortega@example.com", "(361) 555-0133", true)],
        capabilities: ["hss_square", "hss_rectangular", "hss_round"],
      },
    ],
  },
  {
    name: "Nucor Tubular",
    vendor_type: "mill",
    website: "https://www.nucortubular.com",
    notes: `${EXAMPLE_NOTE}; accessed via a partner's account`,
    branches: [
      {
        name: "Nucor Tubular Decatur",
        city: "Decatur",
        state: "AL",
        region: "Southeast",
        preferred: false,
        payment_terms: NET_30,
        early_pay_pct: null,
        early_pay_days: null,
        freight_default: "fob",
        notes: `${EXAMPLE_NOTE}; accessed via a partner's account, no direct terms yet`,
        contacts: [
          contact(
            "Partner desk",
            "nucor.partner@example.com",
            null,
            true,
            "orders go through the partner, not a Nucor rep",
          ),
        ],
        capabilities: ["hss_square", "hss_rectangular", "hss_round", "pipe"],
      },
    ],
  },

  // ---- Service centers ----------------------------------------------------
  {
    name: "Delta Steel",
    vendor_type: "service_center",
    website: "https://www.deltasteel.com",
    notes: `${EXAMPLE_NOTE}; primary Texas service center`,
    branches: [
      {
        name: "Delta Steel Houston",
        city: "Houston",
        state: "TX",
        region: "Gulf Coast",
        preferred: true,
        payment_terms: NET_30_EARLY_1_10,
        early_pay_pct: 1,
        early_pay_days: 10,
        freight_default: "quoted",
        notes: `${EXAMPLE_NOTE}; quotes freight per order, see fixtures/replies/quote.pdf`,
        contacts: [
          contact("Marcus Reed", "marcus.reed@example.com", "(713) 555-0144", true, "inside sales"),
          contact("Priya Natarajan", "priya.natarajan@example.com", "(713) 555-0145", false, "backup"),
        ],
        capabilities: [
          "w_beam",
          "channel",
          "angle",
          "plate",
          "hss_square",
          "hss_rectangular",
          "flat_bar",
        ],
      },
      {
        name: "Delta Steel Fort Worth",
        city: "Fort Worth",
        state: "TX",
        region: "DFW",
        preferred: false,
        payment_terms: NET_30_EARLY_1_10,
        early_pay_pct: 1,
        early_pay_days: 10,
        freight_default: "quoted",
        notes: `${EXAMPLE_NOTE}; closer to DFW deliveries`,
        contacts: [contact("Gary Whitlock", "gary.whitlock@example.com", "(817) 555-0150", true)],
        capabilities: ["w_beam", "channel", "angle", "plate", "flat_bar"],
      },
    ],
  },
  {
    name: "Morgan Steel",
    vendor_type: "service_center",
    website: null,
    notes: `${EXAMPLE_NOTE}; Texas service center`,
    branches: [
      {
        name: "Morgan Steel Texas",
        city: "Houston",
        state: "TX",
        region: "Gulf Coast",
        preferred: true,
        payment_terms: NET_30_EARLY_1_10,
        early_pay_pct: 1,
        early_pay_days: 10,
        freight_default: "arranged",
        notes: `${EXAMPLE_NOTE}; city is a placeholder, verify; broker arranges freight`,
        contacts: [contact("Denise Carver", "denise.carver@example.com", "(713) 555-0161", true)],
        capabilities: ["w_beam", "channel", "angle", "flat_bar", "plate"],
      },
    ],
  },
  {
    name: "Triad Metals",
    vendor_type: "service_center",
    website: "https://www.triadmetals.com",
    notes: `${EXAMPLE_NOTE}; Virginia structural service center`,
    branches: [
      {
        name: "Triad Metals Richmond",
        city: "Richmond",
        state: "VA",
        region: "Mid-Atlantic",
        preferred: false,
        payment_terms: NET_30,
        early_pay_pct: null,
        early_pay_days: null,
        freight_default: "quoted",
        notes: `${EXAMPLE_NOTE}; city is a placeholder, verify; long haul to Texas`,
        contacts: [contact("Kevin Dorsey", "kevin.dorsey@example.com", "(804) 555-0170", true)],
        capabilities: ["w_beam", "channel", "angle", "flat_bar"],
      },
    ],
  },
  {
    name: "Norfolk Iron & Metal",
    vendor_type: "service_center",
    website: "https://www.norfolkiron.com",
    notes: `${EXAMPLE_NOTE}; flat rolled and bar`,
    branches: [
      {
        name: "Norfolk Iron & Metal Main",
        city: "Norfolk",
        state: "NE",
        region: "Midwest",
        preferred: false,
        payment_terms: NET_30,
        early_pay_pct: null,
        early_pay_days: null,
        freight_default: "unknown",
        notes: `${EXAMPLE_NOTE}; city and state are placeholders, verify`,
        contacts: [contact("Sandra Kiel", "sandra.kiel@example.com", "(402) 555-0180", true)],
        capabilities: ["plate", "sheet", "flat_bar", "angle", "channel"],
      },
    ],
  },
  {
    name: "Ryerson",
    vendor_type: "service_center",
    website: "https://www.ryerson.com",
    notes: `${EXAMPLE_NOTE}; broad line service center`,
    branches: [
      {
        name: "Ryerson Houston",
        city: "Houston",
        state: "TX",
        region: "Gulf Coast",
        preferred: false,
        payment_terms: NET_30,
        early_pay_pct: null,
        early_pay_days: null,
        freight_default: "quoted",
        notes: `${EXAMPLE_NOTE}; good for bar, tube, and pipe`,
        contacts: [contact("Alan Moreno", "alan.moreno@example.com", "(713) 555-0190", true)],
        capabilities: [
          "plate",
          "sheet",
          "round_bar",
          "square_bar",
          "hss_square",
          "hss_rectangular",
          "hss_round",
          "pipe",
          "angle",
          "channel",
        ],
      },
    ],
  },
  {
    name: "Metals USA",
    vendor_type: "service_center",
    website: "https://www.metalsusa.com",
    notes: `${EXAMPLE_NOTE}; plate and structural`,
    branches: [
      {
        name: "Metals USA Houston",
        city: "Houston",
        state: "TX",
        region: "Gulf Coast",
        preferred: false,
        payment_terms: NET_30,
        early_pay_pct: null,
        early_pay_days: null,
        freight_default: "quoted",
        notes: `${EXAMPLE_NOTE}; plate processing in house`,
        contacts: [contact("Beth Lindqvist", "beth.lindqvist@example.com", "(713) 555-0201", true)],
        capabilities: ["plate", "w_beam", "channel", "angle", "hss_square"],
      },
    ],
  },
  {
    name: "Alro",
    vendor_type: "service_center",
    website: "https://www.alro.com",
    notes: `${EXAMPLE_NOTE}; bar, plate, and sheet`,
    branches: [
      {
        name: "Alro Texas",
        city: "Dallas",
        state: "TX",
        region: "DFW",
        preferred: false,
        payment_terms: NET_30,
        early_pay_pct: null,
        early_pay_days: null,
        freight_default: "arranged",
        notes: `${EXAMPLE_NOTE}; city is a placeholder, verify`,
        contacts: [contact("Rick Hamel", "rick.hamel@example.com", "(214) 555-0210", true)],
        capabilities: ["plate", "sheet", "flat_bar", "round_bar", "square_bar"],
      },
    ],
  },
  {
    name: "Infra-Metals",
    vendor_type: "service_center",
    website: "https://www.infra-metals.com",
    notes: `${EXAMPLE_NOTE}; structural service center`,
    branches: [
      {
        name: "Infra-Metals Hallsville",
        city: "Hallsville",
        state: "TX",
        region: "East Texas",
        preferred: false,
        payment_terms: NET_30,
        early_pay_pct: null,
        early_pay_days: null,
        freight_default: "arranged",
        notes: `${EXAMPLE_NOTE}; East Texas yard`,
        contacts: [contact("Carla Benningfield", "carla.benningfield@example.com", "(903) 555-0220", true)],
        capabilities: ["w_beam", "channel", "angle", "flat_bar", "plate"],
      },
    ],
  },
  {
    name: "JMS / Russel Metals",
    vendor_type: "service_center",
    website: "https://www.russelmetals.com",
    notes: `${EXAMPLE_NOTE}; JMS Metal Services, part of Russel Metals`,
    branches: [
      {
        name: "JMS Houston",
        city: "Houston",
        state: "TX",
        region: "Gulf Coast",
        preferred: false,
        payment_terms: NET_30,
        early_pay_pct: null,
        early_pay_days: null,
        freight_default: "quoted",
        notes: `${EXAMPLE_NOTE}; structural and tube`,
        contacts: [contact("Omar Haddad", "omar.haddad@example.com", "(713) 555-0230", true)],
        capabilities: ["w_beam", "channel", "angle", "plate", "hss_square", "hss_rectangular"],
      },
    ],
  },
  {
    name: "Phoenix Metals",
    vendor_type: "service_center",
    website: "https://www.phoenixmetals.com",
    notes: `${EXAMPLE_NOTE}; flat rolled`,
    branches: [
      {
        name: "Phoenix Metals Texas",
        city: "Houston",
        state: "TX",
        region: "Gulf Coast",
        preferred: false,
        payment_terms: NET_30,
        early_pay_pct: null,
        early_pay_days: null,
        freight_default: "unknown",
        notes: `${EXAMPLE_NOTE}; city is a placeholder, verify; sheet and plate only`,
        contacts: [contact("Nina Castellano", "nina.castellano@example.com", "(713) 555-0240", true)],
        capabilities: ["sheet", "plate"],
      },
    ],
  },
  {
    name: "O'Neal Steel",
    vendor_type: "service_center",
    website: "https://www.onealsteel.com",
    notes: `${EXAMPLE_NOTE}; has Pronto portal, pricing access removed`,
    branches: [
      {
        name: "O'Neal Steel Houston",
        city: "Houston",
        state: "TX",
        region: "Gulf Coast",
        preferred: false,
        payment_terms: NET_30,
        early_pay_pct: null,
        early_pay_days: null,
        freight_default: "quoted",
        notes: `${EXAMPLE_NOTE}; has Pronto portal, pricing access removed, quote by email`,
        contacts: [contact("Scott Pruitt", "scott.pruitt@example.com", "(713) 555-0250", true)],
        capabilities: [
          "w_beam",
          "channel",
          "angle",
          "plate",
          "hss_square",
          "hss_rectangular",
          "pipe",
          "flat_bar",
        ],
      },
    ],
  },
];

/** Categories the mixed-list.eml fixture needs routed to at least three branches (PLAN Step 5). */
export const MIXED_LIST_CATEGORIES: MaterialCategory[] = ["w_beam", "angle", "plate", "hss_square"];

/** Categories the pdf-list.eml fixture needs at least one branch for. */
export const PDF_LIST_CATEGORIES: MaterialCategory[] = ["hss_square", "w_beam", "angle", "plate", "pipe"];

/** Branch names (across all vendors) whose capabilities include the category. */
export function branchesFor(category: MaterialCategory): string[] {
  const names: string[] = [];
  for (const vendor of SEED_VENDORS) {
    for (const branch of vendor.branches) {
      if (branch.capabilities.includes(category)) {
        names.push(branch.name);
      }
    }
  }
  return names;
}

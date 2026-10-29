// Display labels for the vendor directory enums. Keyed by the enum unions, so
// a value added in SQL fails the type check here until it gets a label. The
// category labels repeat the ones in review/lines-grid.tsx on purpose: that
// file is a client module and a server page cannot read a constant from it.

import {
  freightDefaultValues,
  materialCategoryValues,
  vendorTypeValues,
  type FreightDefault,
  type MaterialCategory,
  type VendorType,
} from "@/lib/db/enums";

export const VENDOR_TYPE_LABELS: Record<VendorType, string> = {
  mill: "Mill",
  service_center: "Service center",
  broker: "Broker",
  other: "Other",
};

export const FREIGHT_DEFAULT_LABELS: Record<FreightDefault, string> = {
  quoted: "Quoted by vendor",
  arranged: "Arranged by broker",
  fob: "FOB",
  unknown: "Unknown",
};

export const CATEGORY_LABELS: Record<MaterialCategory, string> = {
  hss_square: "HSS square",
  hss_rectangular: "HSS rectangular",
  hss_round: "HSS round",
  pipe: "Pipe",
  w_beam: "W beam",
  s_beam: "S beam",
  channel: "Channel",
  angle: "Angle",
  flat_bar: "Flat bar",
  round_bar: "Round bar",
  square_bar: "Square bar",
  plate: "Plate",
  sheet: "Sheet",
  rebar: "Rebar",
};

export const VENDOR_TYPE_OPTIONS = vendorTypeValues.map((value) => ({ value, label: VENDOR_TYPE_LABELS[value] }));
export const FREIGHT_DEFAULT_OPTIONS = freightDefaultValues.map((value) => ({
  value,
  label: FREIGHT_DEFAULT_LABELS[value],
}));
export const CATEGORY_OPTIONS = materialCategoryValues.map((value) => ({ value, label: CATEGORY_LABELS[value] }));

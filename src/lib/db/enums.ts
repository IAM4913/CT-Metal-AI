// Enum mirrors for the Postgres enum types in supabase/migrations/0001_init.sql.
//
// The value tuples come straight from the generated Constants in ./types, so the
// database stays the single source of truth. For each enum this file exports:
//   <name>Values   readonly tuple of the allowed strings
//   <name>Schema   Zod enum for validating at boundaries
//   <Name>         TypeScript union type
// Import from here everywhere else; never redeclare the string lists.

import { z } from "zod";
import { Constants } from "./types";

const dbEnums = Constants.public.Enums;

// broker_members.role
export const memberRoleValues = dbEnums.member_role;
export const memberRoleSchema = z.enum(memberRoleValues);
export type MemberRole = (typeof memberRoleValues)[number];

// requests.source_type
export const requestSourceTypeValues = dbEnums.request_source_type;
export const requestSourceTypeSchema = z.enum(requestSourceTypeValues);
export type RequestSourceType = (typeof requestSourceTypeValues)[number];

// requests.status
export const requestStatusValues = dbEnums.request_status;
export const requestStatusSchema = z.enum(requestStatusValues);
export type RequestStatus = (typeof requestStatusValues)[number];

// request_lines.unit and offer_lines.unit
export const lineUnitValues = dbEnums.line_unit;
export const lineUnitSchema = z.enum(lineUnitValues);
export type LineUnit = (typeof lineUnitValues)[number];

// request_lines.status
export const requestLineStatusValues = dbEnums.request_line_status;
export const requestLineStatusSchema = z.enum(requestLineStatusValues);
export type RequestLineStatus = (typeof requestLineStatusValues)[number];

// catalog_items.category, request_lines.category, vendor_capabilities.category
export const materialCategoryValues = dbEnums.material_category;
export const materialCategorySchema = z.enum(materialCategoryValues);
export type MaterialCategory = (typeof materialCategoryValues)[number];

// catalog_aliases.source
export const aliasSourceValues = dbEnums.alias_source;
export const aliasSourceSchema = z.enum(aliasSourceValues);
export type AliasSource = (typeof aliasSourceValues)[number];

// vendors.vendor_type
export const vendorTypeValues = dbEnums.vendor_type;
export const vendorTypeSchema = z.enum(vendorTypeValues);
export type VendorType = (typeof vendorTypeValues)[number];

// vendor_branches.freight_default
export const freightDefaultValues = dbEnums.freight_default;
export const freightDefaultSchema = z.enum(freightDefaultValues);
export type FreightDefault = (typeof freightDefaultValues)[number];

// rfqs.status
export const rfqStatusValues = dbEnums.rfq_status;
export const rfqStatusSchema = z.enum(rfqStatusValues);
export type RfqStatus = (typeof rfqStatusValues)[number];

// messages.direction
export const messageDirectionValues = dbEnums.message_direction;
export const messageDirectionSchema = z.enum(messageDirectionValues);
export type MessageDirection = (typeof messageDirectionValues)[number];

// messages.matched_by
export const matchedByValues = dbEnums.matched_by;
export const matchedBySchema = z.enum(matchedByValues);
export type MatchedBy = (typeof matchedByValues)[number];

// vendor_offers.source
export const offerSourceValues = dbEnums.offer_source;
export const offerSourceSchema = z.enum(offerSourceValues);
export type OfferSource = (typeof offerSourceValues)[number];

// vendor_offers.status
export const offerStatusValues = dbEnums.offer_status;
export const offerStatusSchema = z.enum(offerStatusValues);
export type OfferStatus = (typeof offerStatusValues)[number];

// offer_lines.availability
export const availabilityValues = dbEnums.availability;
export const availabilitySchema = z.enum(availabilityValues);
export type Availability = (typeof availabilityValues)[number];

// offer_lines.price_basis
export const priceBasisValues = dbEnums.price_basis;
export const priceBasisSchema = z.enum(priceBasisValues);
export type PriceBasis = (typeof priceBasisValues)[number];

// vendor_offers.freight_basis
export const freightBasisValues = dbEnums.freight_basis;
export const freightBasisSchema = z.enum(freightBasisValues);
export type FreightBasis = (typeof freightBasisValues)[number];

// offer_lines.alternate_types (alternate_type[]): in which way an offered item differs from what was asked
export const alternateTypeValues = dbEnums.alternate_type;
export const alternateTypeSchema = z.enum(alternateTypeValues);
export type AlternateType = (typeof alternateTypeValues)[number];

// ---------------------------------------------------------------------------
// Closed string lists stored as text[] in the database and validated here.
// ---------------------------------------------------------------------------

// request_lines.flags: what the parser could not determine or wants a human to check
export const requestLineFlagValues = [
  "missing_grade",
  "missing_qty",
  "missing_length",
  "ambiguous_size",
  "ambiguous_unit",
  "unmatched_item",
  "possible_duplicate",
  "alternate_mentioned",
] as const;
export const requestLineFlagSchema = z.enum(requestLineFlagValues);
export type RequestLineFlag = (typeof requestLineFlagValues)[number];

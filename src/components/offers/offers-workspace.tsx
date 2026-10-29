"use client";

// The Offers tab (PRD FR-9): add a reply (paste, .eml, PDF), enter a phone or
// text quote, then the offers grouped by the RFQ they answer, each with its
// editable lines, and the RFQs still waiting on a reply.
//
// Client component because it holds the banner, the open manual form, and the
// per-card selection lives in the cards. Every write goes through a server
// action in src/app/(app)/requests/[id]/actions.ts and is followed by
// router.refresh(), so the cards show database rows; nothing is patched
// locally.
//
// A superseded revision (supersededBy set, AC-8.4) stays writable here, unlike
// the Review, Route, and RFQs tabs. Its lines, routing, and drafts are history,
// but its RFQs are the ones that went out (PRD section 10: old RFQs stay on the
// old revision), so the vendors' replies to them land here (AC-9.1, AC-9.2) and
// are reviewed here; the newer revision has no sent RFQ until the broker sends
// again. The header says so and links forward for edits to the request itself.

import { format } from "date-fns";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  addOfferLineAction,
  markOfferReviewedAction,
  reExtractOfferAction,
  removeOfferLineAction,
  setOfferDeclinedAction,
  updateOfferAction,
  updateOfferLineAction,
} from "@/app/(app)/requests/[id]/actions";
import { AddReplyPanel, type OpenRfqOption } from "@/components/offers/add-reply-panel";
import { ManualQuoteForm } from "@/components/offers/manual-quote-form";
import { OfferCard, type OfferCardData, type OfferPatch } from "@/components/offers/offer-card";
import type { OfferLineAddInput, OfferLinePatch, OfferRequestLine } from "@/components/offers/offer-lines-grid";
import { RfqStatusBadge } from "@/components/rfqs/rfq-card";
import type { RequestStatus, RfqStatus } from "@/lib/db/enums";
import { wholeDaysSince } from "@/lib/queue/group";
import { compareText } from "@/lib/routing/match";

/** An RFQ of this revision that went out, with the lines it asked about. */
export type OffersRfq = {
  id: string;
  branch_id: string;
  vendor_name: string;
  branch_name: string;
  status: RfqStatus;
  sent_at: string | null;
  /** request_line ids from rfq_lines. */
  line_ids: string[];
};

export type OffersWorkspaceProps = {
  request: { id: string; status: RequestStatus; revision: number };
  rfqs: OffersRfq[];
  offers: OfferCardData[];
  /** Non-removed request lines, in line order, for the request line select and the manual form. */
  requestLines: OfferRequestLine[];
  /** The newer revision's id when this one is superseded; the header then says replies still land here and links forward. */
  supersededBy: string | null;
};

type ActionOutcome = { ok: boolean; error?: string };

/** Statuses a reply can still be attached to (listOpenRfqs in src/lib/server/offers.ts). */
const OPEN_RFQ_STATUSES: ReadonlySet<RfqStatus> = new Set<RfqStatus>(["sent", "responded"]);

const secondaryButton =
  "rounded border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";

/** Vendor, then branch, case-insensitive: the same order as the Route and RFQs tabs. */
export function sortRfqs<T extends { vendor_name: string; branch_name: string }>(rfqs: T[]): T[] {
  return [...rfqs].sort((a, b) => compareText(a.vendor_name, b.vendor_name) || compareText(a.branch_name, b.branch_name));
}

/**
 * "3 days ago" or "sent under a day ago" since an RFQ went out, for the
 * awaiting list (AC-12.2). Elapsed whole days through wholeDaysSince, the same
 * rule as the work queue card and the purchase bar, so the three screens agree.
 */
export function daysSince(sentAt: string, now: Date): string {
  const days = wholeDaysSince(sentAt, now);
  if (days === null) return "sent";
  if (days === 0) return "sent under a day ago";
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function OffersWorkspace({ request, rfqs, offers, requestLines, supersededBy }: OffersWorkspaceProps) {
  const router = useRouter();
  const superseded = supersededBy !== null;
  const [banner, setBanner] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [showManual, setShowManual] = useState(false);

  const sortedRfqs = useMemo(() => sortRfqs(rfqs), [rfqs]);
  const openRfqs = useMemo<OpenRfqOption[]>(
    () =>
      sortedRfqs
        .filter((rfq) => OPEN_RFQ_STATUSES.has(rfq.status))
        .map(({ id, vendor_name, branch_name, status, sent_at }) => ({ id, vendor_name, branch_name, status, sent_at })),
    [sortedRfqs],
  );
  const rfqLineIds = useMemo(() => Object.fromEntries(rfqs.map((rfq) => [rfq.id, rfq.line_ids])), [rfqs]);

  const offersByRfq = useMemo(() => {
    const map = new Map<string, OfferCardData[]>();
    for (const offer of offers) {
      const list = map.get(offer.rfq_id) ?? [];
      list.push(offer);
      map.set(offer.rfq_id, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.received_at.localeCompare(b.received_at));
    }
    return map;
  }, [offers]);

  const groups = sortedRfqs
    .map((rfq) => ({ rfq, offers: offersByRfq.get(rfq.id) ?? [] }))
    .filter((group) => group.offers.length > 0);
  const awaiting = sortedRfqs.filter((rfq) => (offersByRfq.get(rfq.id) ?? []).length === 0);
  // Offers whose RFQ is not in the list (another revision, or a status the page filtered out) still show.
  const orphanOffers = offers.filter((offer) => !rfqs.some((rfq) => rfq.id === offer.rfq_id));
  const respondedCount = groups.length;

  // Run a server action; on success refresh the server components so the cards
  // show the stored rows. Resolves to the error message for the caller's cell.
  const run = useCallback(
    async (work: () => Promise<ActionOutcome>): Promise<string | null> => {
      let result: ActionOutcome;
      try {
        result = await work();
      } catch (error) {
        console.error("[offers] action failed", error);
        return "The request did not reach the server. Try again.";
      }
      if (!result.ok) return result.error ?? "Something went wrong. Try again.";
      router.refresh();
      return null;
    },
    [router],
  );

  const onUpdateLine = useCallback(
    (lineId: string, patch: OfferLinePatch) => run(() => updateOfferLineAction(lineId, patch)),
    [run],
  );
  const onAddLine = useCallback(
    (offerId: string, input: OfferLineAddInput) => run(() => addOfferLineAction(offerId, input)),
    [run],
  );
  const onRemoveLine = useCallback((lineId: string) => run(() => removeOfferLineAction(lineId)), [run]);
  const onUpdateOffer = useCallback(
    (offerId: string, patch: OfferPatch) => run(() => updateOfferAction(offerId, patch)),
    [run],
  );
  const onMarkReviewed = useCallback((offerId: string) => run(() => markOfferReviewedAction(offerId)), [run]);
  const onSetDeclined = useCallback(
    (offerId: string, declined: boolean) => run(() => setOfferDeclinedAction(offerId, declined)),
    [run],
  );
  const onReExtract = useCallback((offerId: string) => run(() => reExtractOfferAction(offerId)), [run]);

  function announce(text: string) {
    setBanner({ tone: "ok", text });
    router.refresh();
  }

  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded border border-zinc-200 bg-zinc-50 px-4 py-3">
        <div className="flex flex-col gap-1 text-sm text-zinc-700">
          <span>
            <span className="font-medium tabular-nums">
              {respondedCount} of {rfqs.length}
            </span>{" "}
            {rfqs.length === 1 ? "RFQ has" : "RFQs have"} a reply
            {offers.length > 0 ? (
              <span className="text-zinc-500">
                {" "}
                ({offers.length} {offers.length === 1 ? "offer" : "offers"})
              </span>
            ) : null}
          </span>
          {superseded ? (
            <span className="text-xs text-amber-800">
              This revision has been superseded, but its RFQs are the ones that went out, so vendor replies to them
              land here: add and review them below. Edits to the request itself belong on{" "}
              <Link href={`/requests/${supersededBy}`} className="font-medium underline hover:text-amber-700">
                the newer revision
              </Link>
              .
            </span>
          ) : rfqs.length === 0 ? (
            <span className="text-xs text-zinc-600">
              Nothing has been sent on this revision. Send the RFQs from the{" "}
              <Link href={`/requests/${request.id}/rfqs`} className="font-medium text-zinc-900 underline hover:text-zinc-700">
                RFQs tab
              </Link>{" "}
              and the replies land here.
            </span>
          ) : (
            <span className="text-xs text-zinc-600">
              Each reply is extracted into offer lines tied to the request lines. Review them here; the Compare tab
              reads reviewed and parsed offers side by side.
            </span>
          )}
        </div>
        {showManual ? null : (
          <button type="button" onClick={() => setShowManual(true)} disabled={openRfqs.length === 0} className={secondaryButton}>
            Enter a phone or text quote
          </button>
        )}
      </div>

      {banner ? (
        <p
          role={banner.tone === "error" ? "alert" : "status"}
          className={
            banner.tone === "error"
              ? "rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              : "rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          }
        >
          {banner.text}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <AddReplyPanel requestId={request.id} openRfqs={openRfqs} disabled={false} onIngested={announce} />
        <AwaitingList rfqs={awaiting} now={now} />
      </div>

      {showManual ? (
        <ManualQuoteForm
          rfqs={openRfqs}
          rfqLineIds={rfqLineIds}
          requestLines={requestLines}
          disabled={false}
          onCreated={(text) => {
            setShowManual(false);
            announce(text);
          }}
          onCancel={() => setShowManual(false)}
        />
      ) : null}

      <main className="flex flex-col gap-8">
        <section aria-labelledby="offers-heading" className="flex flex-col gap-4">
          <div>
            <h2 id="offers-heading" className="text-lg font-semibold">
              Offers
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              Grouped by the RFQ they answer. A declined reply is kept as an offer with no lines so the queue stops
              waiting on it.
            </p>
          </div>

          {groups.length === 0 && orphanOffers.length === 0 ? (
            <p className="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-500">
              No offers yet. Add a reply above, or enter a phone or text quote.
            </p>
          ) : null}

          {groups.map(({ rfq, offers: rfqOffers }) => (
            <section key={rfq.id} aria-labelledby={`rfq-group-${rfq.id}`} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 pb-2">
                <h3 id={`rfq-group-${rfq.id}`} className="text-base font-semibold text-zinc-900">
                  {rfq.vendor_name} <span className="font-normal text-zinc-600">{rfq.branch_name}</span>
                </h3>
                <RfqStatusBadge status={rfq.status} />
                {rfq.sent_at ? (
                  <span className="text-xs text-zinc-500">RFQ sent {format(new Date(rfq.sent_at), "MMM d, yyyy h:mm a")}</span>
                ) : null}
                <span className="ml-auto text-xs text-zinc-500">
                  {rfqOffers.length} {rfqOffers.length === 1 ? "offer" : "offers"}
                </span>
              </div>
              {rfqOffers.map((offer) => (
                <OfferCard
                  key={offer.id}
                  offer={offer}
                  requestLines={requestLines}
                  readOnly={false}
                  onUpdateOffer={(patch) => onUpdateOffer(offer.id, patch)}
                  onUpdateLine={onUpdateLine}
                  onAddLine={(input) => onAddLine(offer.id, input)}
                  onRemoveLine={onRemoveLine}
                  onMarkReviewed={() => onMarkReviewed(offer.id)}
                  onSetDeclined={(declined) => onSetDeclined(offer.id, declined)}
                  onReExtract={() => onReExtract(offer.id)}
                />
              ))}
            </section>
          ))}

          {orphanOffers.length > 0 ? (
            <section aria-labelledby="other-offers-heading" className="flex flex-col gap-3">
              <h3 id="other-offers-heading" className="border-b border-zinc-200 pb-2 text-base font-semibold text-zinc-900">
                Other offers
              </h3>
              {orphanOffers.map((offer) => (
                <OfferCard
                  key={offer.id}
                  offer={offer}
                  requestLines={requestLines}
                  readOnly={false}
                  onUpdateOffer={(patch) => onUpdateOffer(offer.id, patch)}
                  onUpdateLine={onUpdateLine}
                  onAddLine={(input) => onAddLine(offer.id, input)}
                  onRemoveLine={onRemoveLine}
                  onMarkReviewed={() => onMarkReviewed(offer.id)}
                  onSetDeclined={(declined) => onSetDeclined(offer.id, declined)}
                  onReExtract={() => onReExtract(offer.id)}
                />
              ))}
            </section>
          ) : null}
        </section>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sent RFQs with no offer yet (AC-12.1 "awaiting responses", per RFQ)
// ---------------------------------------------------------------------------

function AwaitingList({ rfqs, now }: { rfqs: OffersRfq[]; now: Date }) {
  return (
    <section aria-labelledby="awaiting-heading" className="flex flex-col gap-3 rounded border border-zinc-200 p-4">
      <div>
        <h2 id="awaiting-heading" className="text-lg font-semibold">
          Awaiting a reply
        </h2>
        <p className="mt-1 text-sm text-zinc-600">RFQs that went out and have no offer yet.</p>
      </div>
      {rfqs.length === 0 ? (
        <p className="text-sm text-zinc-500">Every sent RFQ has a reply.</p>
      ) : (
        <ul className="divide-y divide-zinc-200 rounded border border-zinc-200 text-sm">
          {rfqs.map((rfq) => (
            <li key={rfq.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="font-medium text-zinc-900">
                {rfq.vendor_name} <span className="font-normal text-zinc-600">{rfq.branch_name}</span>
              </span>
              <RfqStatusBadge status={rfq.status} />
              <span className="ml-auto text-xs text-zinc-500">
                {rfq.sent_at ? `${daysSince(rfq.sent_at, now)} (${format(new Date(rfq.sent_at), "MMM d")})` : "not sent"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

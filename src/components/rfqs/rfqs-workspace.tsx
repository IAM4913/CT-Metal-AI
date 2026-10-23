"use client";

// The RFQs tab (PRD FR-7, FR-8): a top bar with "Send all" and the sent count,
// then one card per RFQ. Sending needs two clicks (the button, then the confirm
// dialog that lists every branch about to receive mail), and nothing else on
// this tab reaches the mail adapter. Every write goes through a server action
// and is followed by router.refresh(), so the cards show database rows. A
// superseded revision (supersededBy set, AC-8.4) is read-only: nothing on it
// can be edited or sent, and the note links to the newer revision.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import {
  regenerateDraftAction,
  retryRfqAction,
  sendAllAction,
  updateDraftAction,
} from "@/app/(app)/requests/[id]/actions";
import { RfqCard, type DraftPatch, type RfqCardData } from "@/components/rfqs/rfq-card";
import type { RequestStatus, RfqStatus } from "@/lib/db/enums";
import type { SendOutcome } from "@/lib/rfq/send";

export type RfqsWorkspaceProps = {
  request: { id: string; status: RequestStatus; revision: number };
  rfqs: RfqCardData[];
  /** The newer revision's id when this one is superseded; the tab is then read-only. */
  supersededBy: string | null;
};

type ActionOutcome = { ok: true } | { ok: false; error: string };

/** sendAll picks up these statuses (src/lib/rfq/send.ts). */
const SENDABLE: ReadonlySet<RfqStatus> = new Set<RfqStatus>(["draft", "queued", "failed"]);

/** Statuses before Confirm on the Review tab; sendAll refuses these (sendBlockedReason in src/lib/server/rfq-send.ts). */
const BEFORE_REVIEW: ReadonlySet<RequestStatus> = new Set<RequestStatus>(["new", "parsing", "needs_review"]);

const primaryButton =
  "rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400";
const secondaryButton =
  "rounded border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";

async function runAction(work: () => Promise<ActionOutcome>): Promise<string | null> {
  try {
    const result = await work();
    return result.ok ? null : result.error;
  } catch (error) {
    console.error("[rfqs] action failed", error);
    return "The request did not reach the server. Try again.";
  }
}

/** The outcomes off an action result: sendAll answers with a list, retry with one. */
function outcomesOf(result: unknown): SendOutcome[] {
  if (result === null || typeof result !== "object") return [];
  const { outcomes, outcome } = result as { outcomes?: unknown; outcome?: unknown };
  if (Array.isArray(outcomes)) return outcomes as SendOutcome[];
  return outcome !== null && typeof outcome === "object" ? [outcome as SendOutcome] : [];
}

/** "3 sent, 1 failed." style summary of a send. */
export function summarizeOutcomes(outcomes: SendOutcome[]): string {
  if (outcomes.length === 0) return "Nothing to send.";
  const counts = { sent: 0, skipped_already_sent: 0, skipped_no_recipient: 0, failed: 0 };
  for (const outcome of outcomes) counts[outcome.result] += 1;
  const parts: string[] = [];
  if (counts.sent > 0) parts.push(`${counts.sent} sent`);
  if (counts.skipped_already_sent > 0) parts.push(`${counts.skipped_already_sent} already sent`);
  if (counts.skipped_no_recipient > 0) parts.push(`${counts.skipped_no_recipient} with no recipient`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return `${parts.join(", ")}.`;
}

export function RfqsWorkspace({ request, rfqs, supersededBy }: RfqsWorkspaceProps) {
  const router = useRouter();
  const readOnly = supersededBy !== null;
  const [sending, startSend] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [banner, setBanner] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const sendable = readOnly ? [] : rfqs.filter((rfq) => SENDABLE.has(rfq.status));
  const sentCount = rfqs.filter((rfq) => rfq.status === "sent").length;
  const unconfirmed = BEFORE_REVIEW.has(request.status);

  const onUpdate = useCallback(
    (rfqId: string, patch: DraftPatch) => runAction(() => updateDraftAction(rfqId, patch)),
    [],
  );
  const onRegenerate = useCallback((rfqId: string) => runAction(() => regenerateDraftAction(rfqId)), []);
  const onRetry = useCallback(
    async (rfqId: string): Promise<string | null> => {
      setBanner(null);
      let result: Awaited<ReturnType<typeof retryRfqAction>>;
      try {
        result = await retryRfqAction(rfqId);
      } catch (error) {
        console.error("[rfqs] retry failed", error);
        return "The request did not reach the server. Try again.";
      }
      if (!result.ok) return result.error;
      const outcomes = outcomesOf(result);
      const failed = outcomes.find((outcome) => outcome.result === "failed");
      if (failed) return failed.error ?? "The send failed again.";
      setBanner({ tone: "ok", text: summarizeOutcomes(outcomes) });
      return null;
    },
    [],
  );

  function sendAll() {
    setConfirming(false);
    setBanner(null);
    startSend(async () => {
      let result: Awaited<ReturnType<typeof sendAllAction>>;
      try {
        result = await sendAllAction(request.id);
      } catch (error) {
        console.error("[rfqs] send all failed", error);
        setBanner({ tone: "error", text: "The request did not reach the server. Try again." });
        return;
      }
      if (!result.ok) {
        setBanner({ tone: "error", text: result.error });
        return;
      }
      const outcomes = outcomesOf(result);
      const anyFailed = outcomes.some((outcome) => outcome.result === "failed" || outcome.result === "skipped_no_recipient");
      setBanner({ tone: anyFailed ? "error" : "ok", text: summarizeOutcomes(outcomes) });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded border border-zinc-200 bg-zinc-50 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={sending || sendable.length === 0 || unconfirmed || readOnly}
            className={primaryButton}
            title={
              readOnly
                ? "This revision has been superseded"
                : unconfirmed
                  ? "Confirm the request on the Review tab before sending"
                  : sendable.length === 0
                    ? "Nothing to send: every RFQ is already sent, or there are no drafts"
                    : undefined
            }
          >
            {sending ? "Sending..." : `Send all (${sendable.length})`}
          </button>
          <span className="text-xs text-zinc-600">
            Sends every draft, queued, and failed RFQ to its own branch. Nothing goes out until you confirm.
          </span>
          {readOnly ? (
            <span className="text-xs text-amber-800">
              Read-only. This revision has been superseded; its drafts stay as they were. Work on{" "}
              <Link href={`/requests/${supersededBy}/rfqs`} className="font-medium underline hover:text-amber-700">
                the newer revision
              </Link>
              .
            </span>
          ) : null}
          {!readOnly && unconfirmed ? (
            <span className="text-xs text-amber-800">
              The request is not confirmed yet. Drafts can be edited now; confirm it on the{" "}
              <Link href={`/requests/${request.id}`} className="font-medium underline hover:text-amber-700">
                Review tab
              </Link>{" "}
              before sending.
            </span>
          ) : null}
        </div>
        <div className="text-sm text-zinc-700">
          <span className="font-medium tabular-nums">
            {sentCount} of {rfqs.length}
          </span>{" "}
          sent
        </div>
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

      {rfqs.length === 0 ? (
        <p className="rounded border border-zinc-200 px-3 py-6 text-center text-sm text-zinc-500">
          No drafts yet. Pick branches on the{" "}
          <Link href={`/requests/${request.id}/route`} className="font-medium text-zinc-900 underline hover:text-zinc-700">
            Route tab
          </Link>
          ; a draft appears here for every branch a line is routed to.
        </p>
      ) : (
        <main className="flex flex-col gap-4">
          {rfqs.map((rfq) => (
            <RfqCard
              key={rfq.id}
              rfq={rfq}
              busy={sending}
              readOnly={readOnly}
              onUpdate={(patch) => onUpdate(rfq.id, patch)}
              onRegenerate={() => onRegenerate(rfq.id)}
              onRetry={() => onRetry(rfq.id)}
            />
          ))}
        </main>
      )}

      {confirming ? <SendAllDialog rfqs={sendable} onConfirm={sendAll} onClose={() => setConfirming(false)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

function SendAllDialog({
  rfqs,
  onConfirm,
  onClose,
}: {
  rfqs: RfqCardData[];
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const withRecipient = rfqs.filter((rfq) => rfq.to_emails.length > 0);
  const noRecipient = rfqs.filter((rfq) => rfq.to_emails.length === 0);

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-zinc-900/40 p-4 pt-24"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-all-heading"
        className="flex w-full max-w-lg flex-col gap-4 rounded border border-zinc-200 bg-white p-5 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <h2 id="send-all-heading" className="text-lg font-semibold">
            Send {rfqs.length === 1 ? "1 RFQ" : `${rfqs.length} RFQs`}?
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Each branch gets its own message with only its lines. Sent RFQs cannot be edited; a later line edit
            starts a new revision.
          </p>
        </div>

        <ul className="max-h-72 divide-y divide-zinc-200 overflow-auto rounded border border-zinc-200 text-sm">
          {rfqs.map((rfq) => (
            <li key={rfq.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
              <span className="font-medium text-zinc-900">
                {rfq.vendor_name} <span className="font-normal text-zinc-600">{rfq.branch_name}</span>
              </span>
              <span className="ml-auto break-all text-xs text-zinc-500">
                {rfq.to_emails.length > 0 ? rfq.to_emails.join(", ") : <span className="text-amber-800">no recipient</span>}
              </span>
            </li>
          ))}
        </ul>

        {noRecipient.length > 0 ? (
          <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {noRecipient.length === 1 ? "One RFQ has" : `${noRecipient.length} RFQs have`} no To address and will be
            marked failed. Add an address on the card, or send the rest now and retry later.
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryButton}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={withRecipient.length === 0} className={primaryButton}>
            Send {withRecipient.length === 1 ? "1 RFQ" : `${withRecipient.length} RFQs`}
          </button>
        </div>
      </div>
    </div>
  );
}

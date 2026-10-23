// Review tab (AC-1.4, AC-3.1): the original source beside the parsed lines.
// Step 3 shows the source text, the stored attachments, and whatever lines
// intake wrote (manual entry only); Step 4 adds parsing and the editable grid.

import { notFound } from "next/navigation";
import { LinesTable } from "@/components/lines-table";
import { SourcePane } from "@/components/source-pane";
import { loadRequestWorkspace } from "@/lib/server/requests";

type ReviewPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ReviewPage({ params }: ReviewPageProps) {
  const { id } = await params;
  const workspace = await loadRequestWorkspace(id);
  if (!workspace) notFound();

  const { request, lines, attachments, messages } = workspace;
  // The inbound email that created the request, when there is one.
  const inbound = messages.find((message) => message.direction === "in") ?? null;

  return (
    <main className="grid gap-8 lg:grid-cols-[2fr_3fr]">
      <SourcePane sourceText={request.source_text} attachments={attachments} message={inbound} />
      <LinesTable lines={lines} />
    </main>
  );
}

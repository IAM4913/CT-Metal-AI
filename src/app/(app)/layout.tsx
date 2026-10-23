import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import { requireBroker } from "@/lib/server/session";

// Every page in this group reads the session cookie, so nothing here can be
// prerendered at build time.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { email } = await requireBroker();

  return (
    <>
      <Nav email={email} />
      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</div>
    </>
  );
}

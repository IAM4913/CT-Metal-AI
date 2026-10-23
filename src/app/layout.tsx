import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Anvil",
  description: "Back office for independent steel brokers",
};

// Typed explicitly (not with the generated LayoutProps helper) so a plain
// `tsc --noEmit` works on a fresh checkout before `next build` has run typegen.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-white text-zinc-900">
        {children}
      </body>
    </html>
  );
}

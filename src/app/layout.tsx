import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Anvil",
  description: "Back office for independent steel brokers",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-white text-zinc-900">
        {children}
      </body>
    </html>
  );
}

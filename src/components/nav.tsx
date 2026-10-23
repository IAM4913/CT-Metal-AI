import Link from "next/link";
import { signOut } from "@/app/login/actions";

const links = [
  { href: "/", label: "Queue" },
  { href: "/requests/new", label: "New request" },
  { href: "/vendors", label: "Vendors" },
  { href: "/items", label: "Items" },
  { href: "/history", label: "History" },
] as const;

type NavProps = {
  email: string | null;
};

export function Nav({ email }: NavProps) {
  return (
    <header className="border-b border-zinc-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="text-base font-semibold text-zinc-900">
          Anvil
        </Link>
        <nav aria-label="Main" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="text-zinc-700 hover:text-zinc-900 hover:underline">
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {email ? <span className="text-zinc-600">{email}</span> : null}
          <form action={signOut}>
            <button
              type="submit"
              className="rounded border border-zinc-300 px-2 py-1 text-zinc-700 hover:bg-zinc-100"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}

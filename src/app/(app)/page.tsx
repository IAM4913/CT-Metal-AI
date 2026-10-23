import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1 className="text-2xl font-semibold">Anvil</h1>
      <p className="mt-2 text-zinc-600">
        Back office for independent steel brokers. Work queue coming in Step 8.
      </p>
      <p className="mt-4 text-sm">
        <Link href="/requests/new" className="font-medium text-zinc-900 underline hover:text-zinc-700">
          Start a new request
        </Link>
        <span className="text-zinc-600"> (paste a list, upload an .eml, or enter lines by hand)</span>
      </p>
    </main>
  );
}

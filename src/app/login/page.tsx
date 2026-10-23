import { signIn } from "./actions";

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const failed = params.error !== undefined;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold">Anvil</h1>
      <p className="mt-1 text-sm text-zinc-600">Sign in to your broker workspace.</p>

      <form action={signIn} className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-800">Email</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            className="rounded border border-zinc-300 px-3 py-2 text-base text-zinc-900 outline-none focus:border-zinc-500"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-800">Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            className="rounded border border-zinc-300 px-3 py-2 text-base text-zinc-900 outline-none focus:border-zinc-500"
          />
        </label>

        {failed ? (
          <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Sign in failed. Check the email and password and try again.
          </p>
        ) : null}

        <button
          type="submit"
          className="mt-2 rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}

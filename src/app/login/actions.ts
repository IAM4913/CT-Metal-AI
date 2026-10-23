"use server";

// Sign in and sign out. Thin: validate, call Supabase Auth, redirect.
// redirect() throws, so it is called outside any try/catch.

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/db/client";

const credentialsSchema = z.object({
  // Normalize first, then validate the format, so " A@B.com " is accepted as a@b.com.
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1),
});

export async function signIn(formData: FormData): Promise<void> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    redirect("/login?error=1");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    redirect("/login?error=1");
  }

  redirect("/");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

# Supabase cloud foundation setup

M6.4 adds optional authentication and secured cloud infrastructure. M6.5 synchronizes account-owned lesson snapshots while IndexedDB remains the immediate local cache.

## Configure Supabase

1. Create a Supabase project.
2. In the project API settings, copy the Project URL and publishable key.
3. Copy `.env.example` to `.env.local` if needed and set:

   ```text
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
   ```

   Keep `GEMINI_API_KEY` server-side as it is today. Never add a Supabase service-role key to a `NEXT_PUBLIC_` variable.

4. Open the Supabase SQL editor and apply `supabase/migrations/20260903000000_cloud_foundation.sql`.
5. In Storage, verify that `lesson-sources` exists and is **private**.

The migration creates the tables, ownership constraints, grants, Row Level Security policies, private bucket, and object-path policies. Future files use `<userId>/<lessonId>/<sourceId>/<safeFilename>`.

## Auth URL configuration

In Authentication URL Configuration:

- Set the Site URL to the stable production URL (or `http://localhost:3000` while developing).
- Add redirect URLs for `http://localhost:3000/auth/confirm` and each stable production domain's `/auth/confirm` path.
- For SSR email confirmation, configure the confirmation template to send `token_hash` and `type=email` to `/auth/confirm`, following Supabase's SSR email-confirmation template guidance.

Email/password sign-up respects the project's Supabase email-confirmation setting. If confirmation is enabled, the app asks the learner to check email before signing in.

## Vercel

Add both public Supabase values to the required Development, Preview, and Production environments. Each deployment must use an allowed Auth redirect URL. Do not add `SUPABASE_SERVICE_ROLE_KEY`; M6.4 does not need it.

## Boundaries and verification

- Account-owned lesson snapshots are synchronized to `public.lessons`; Recent Lessons still renders from the scoped IndexedDB cache.
- Original PDF/TXT files are not uploaded, and `lesson_sources` remains unused by the application.
- Signing out never deletes local lessons.
- Existing unowned local lessons require the explicit “Sync local lessons to this account” action. They are never silently claimed at sign-in.
- With the environment variables omitted, the tutor remains fully local-first and the Cloud card reports “Not configured.”
- Test RLS with two users before enabling synchronization: neither database rows nor Storage paths belonging to the other user should be accessible.

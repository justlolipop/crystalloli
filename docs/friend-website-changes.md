# Changes to the Pustaka Jasa website (for connecting Crystal Studio)

A running list of everything changed on the Pustaka Jasa side (the school
order website and its Supabase database) while connecting it to Crystal
Studio. Every change made in the website's own code is also marked in the
code with a comment that starts with `CRYSTALLOLI:` — search for that word
to find them all.

Each entry says whether the **real** website needs it. Work is done on a
**copy** of the website that uses its own **test** Supabase project, so
nothing here touches the real website or the company's data until it is
copied over on purpose.

---

## 2026-10-08 — Test copy and test database (real website: not needed)

- **Test database** — a new, separate Supabase project (not the company's)
  was set up with `pustaka-test-setup.sql`. That file:
  - rebuilds the tables the real project created by hand in the Supabase
    dashboard before its first migration, so they are not in
    `supabase/migrations`: `profiles` (id, role, sekolah, display_name,
    created_at, with a `profiles_role_check`), `salesman_assignments`, and
    the old other-app tables `teachers`, `staff`, `order_items`,
    `order_item_breakdown` (only so migrations 0004/0011 can run);
  - adds `orders.created_by` (uuid → profiles, default `auth.uid()`), which
    the real `orders` table has but no migration adds;
  - runs every migration in `supabase/migrations`, 0001 to 0084, unchanged;
  - adds 7 clearly fake test accounts (`…@test.fake`, names start with
    `TEST`, schools end with `(FAKE SCHOOL)`), password `TestFake123!`.
  - **Never run it on the real project.**
  - Worth knowing for the real project: migrations 0001–0084 alone can't
    rebuild the database from scratch, because of the hand-made tables and
    the missing `orders.created_by` above.
- **The copy's `.env`** points at the test project. `.env` is never
  uploaded to GitHub.
- **No change to the website's code yet.**

## 2026-10-08 — Security note (real website: action needed)

- The real project's `.env` (including `SUPABASE_SERVICE_ROLE_KEY`) was
  uploaded by mistake to a GitHub repo that was public for a while. It was
  deleted and the repo made private, but the **service_role key of the real
  project should be regenerated** in Supabase (Project Settings → API Keys)
  and the new key put wherever the real website uses it.

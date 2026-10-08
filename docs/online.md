# Crystal Studio online

Crystal Studio can keep everything online (Supabase) and run as a website (GitHub Pages), so
anyone opens one link and sees the same designs. The order website's Crystal Preview uses it too.

## Set it up (once)

1. **Database**: in Supabase (the TEST project), open **SQL Editor → New query**, paste all of
   `supabase/crystal_studio.sql`, press **Run**. It should say "Success. No rows returned".
2. **Key**: Supabase → **Project Settings → API Keys** → copy the **Publishable key**
   (`sb_publishable_…`). Put it in `js/config.js` as `SUPABASE_KEY` (never the secret key).
3. **Move your designs online**: in the crystal project folder run `node upload-online.js`.
   Fonts other computers may not have: copy the font files into a `webfonts` folder first (named
   by PostScript name, e.g. `BritannicBold.ttf`, `Teko-Bold.ttf`, `Playball-Regular.ttf`).
4. **Website**: GitHub → crystalloli → **Settings → Pages** → Source **Deploy from a branch**,
   branch **main**, folder **/ (root)** → Save. After a minute or two it's at
   https://justlolipop.github.io/crystalloli/

## Notes

- Anyone with the link can change designs (no login), as chosen. Saved designs include Excel
  rows (students' names): before real orders, switch the policies in the SQL to `authenticated`.
- Files over 50 MB (Supabase free plan) can't be kept online: such a design still imports, but
  without full-quality downloads and "Remove from background".
- The template folder and "open in Illustrator" use this PC, so they only work when Crystal Studio
  runs here (`node server.js`); it then still reads and saves online.

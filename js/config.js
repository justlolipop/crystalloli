// Where Crystal Studio keeps its designs, master template and saved work.
// With SUPABASE_KEY filled in: online, in Supabase, shared by everyone who opens the studio
// (run supabase/crystal_studio.sql in that project once first). Empty: on this PC only
// (library\, designs\, master.json next to server.js).
//
// The key here is the project's PUBLISHABLE (anon) key: it is meant to be in web pages.
// Never put the secret / service_role key here; the page refuses it.
export const SUPABASE_URL = "https://ddjgmuvgxywzvhzhrbta.supabase.co"; // the TEST project
export const SUPABASE_KEY = "sb_publishable_YoJRrnXu4MTEyj5jiP0Kow_2Z2RlElm";

// Opening a design that the Excel's jenis_plak didn't pick (to change it) asks for this password.
// Only its SHA-256 is kept here. It stops mistakes, not a determined person: anyone can still
// change the designs through the database (see supabase/crystal_studio.sql).
// To change it: put the new password's SHA-256 here (e.g. https://emn178.github.io/online-tools/sha256.html).
export const EDIT_PASSWORD_SHA256 = "0b67579a10e1bdf91d85e65414dc38fcab9b973a97ab661a169a0813338ce7bd"; // "loli"

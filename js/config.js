// Where Crystal Studio keeps its designs, master template and saved work.
// With SUPABASE_KEY filled in: online, in Supabase, shared by everyone who opens the studio
// (run supabase/crystal_studio.sql in that project once first). Empty: on this PC only
// (library\, designs\, master.json next to server.js).
//
// The key here is the project's PUBLISHABLE (anon) key: it is meant to be in web pages.
// Never put the secret / service_role key here; the page refuses it.
export const SUPABASE_URL = "https://ddjgmuvgxywzvhzhrbta.supabase.co"; // the TEST project
export const SUPABASE_KEY = "sb_publishable_YoJRrnXu4MTEyj5jiP0Kow_2Z2RlElm";

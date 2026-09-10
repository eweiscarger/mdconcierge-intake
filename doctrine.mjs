// The doctrine loader.
//
// This repository is PUBLIC. It has to be: intake.mjs and watchdog.mjs each run a continuous
// 54 minute loop all day, which is roughly 78,000 Actions minutes a month. Private repositories
// get 2,000. Making it private costs about six hundred dollars a month or stops the engine.
//
// So the code is public and the playbook is not. Anything that says what Eric sells, how he says
// it, what the economics are, what the objections are and how they are answered lives in the
// mdrx_doctrine table in Supabase, which is private, RLS on, and reachable only with the service
// key the workflows already hold. This file fetches it at runtime.
//
// If a prompt cannot be loaded the job STOPS. It does not fall back to something weaker and it does
// not improvise. A drafter running without its rules is worse than a drafter that did not run.
const REST = () => process.env.SUPABASE_URL + '/rest/v1/';
const HEAD = () => ({
  apikey: process.env.SUPABASE_SERVICE_KEY,
  Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
});

const cache = new Map();

/**
 * Load one piece of doctrine by key. Throws if it is missing, because every caller needs it.
 * @param {string} key
 * @returns {Promise<string>}
 */
export async function doctrine(key) {
  if (cache.has(key)) return cache.get(key);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('doctrine: SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  }
  const r = await fetch(`${REST()}mdrx_doctrine?select=body&key=eq.${encodeURIComponent(key)}`, { headers: HEAD() });
  if (!r.ok) throw new Error(`doctrine "${key}": ${r.status} ${await r.text()}`);
  const rows = await r.json();
  if (!rows.length || !rows[0].body) throw new Error(`doctrine "${key}" is not in mdrx_doctrine`);
  cache.set(key, rows[0].body);
  return rows[0].body;
}

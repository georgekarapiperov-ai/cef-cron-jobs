// File-based stand-in for @vercel/kv, used ONLY inside GitHub Actions (see scripts/run-job.mjs).
// The existing Vercel code (news-*.js, nav-check.js, holdings-check.js, nav-data.js, news.js) runs
// unchanged; everything it would have saved in Upstash is kept in one JSON file instead, which the
// workflow publishes to a data-* branch. KV_FILE = path of that JSON file.
import fs from "node:fs";
const FILE = process.env.KV_FILE;
let store = {};
try { if (FILE && fs.existsSync(FILE)) store = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { console.warn("[kv-shim] could not read", FILE, e.message); store = {}; }
const clone = v => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
export const kv = {
  async get(k) { return clone(store[k]); },
  async set(k, v) { store[k] = clone(v); return "OK"; },
  async del(...ks) { let n = 0; ks.flat().forEach(k => { if (k in store) { delete store[k]; n++; } }); return n; },
  async mget(...ks) { return ks.flat().map(k => clone(store[k])); },
  async lpush(k, ...vals) { const a = Array.isArray(store[k]) ? store[k] : []; vals.flat().forEach(v => a.unshift(v)); store[k] = a; return a.length; },
  async ltrim(k, start, stop) { const a = Array.isArray(store[k]) ? store[k] : []; store[k] = a.slice(start, stop < 0 ? undefined : stop + 1); return "OK"; },
  async lrange(k, start, stop) { const a = Array.isArray(store[k]) ? store[k] : []; return a.slice(start, stop < 0 ? undefined : stop + 1); },
  async keys(pattern = "*") { const re = new RegExp("^" + pattern.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"); return Object.keys(store).filter(k => re.test(k)); },
  __save() { if (FILE) fs.writeFileSync(FILE, JSON.stringify(store)); return Object.keys(store).length; }
};
export default kv;

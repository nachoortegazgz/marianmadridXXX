/*
=============================================================================
MODULE: backend/tests/loader.mjs
PURPOSE: Offline test harness. Registers ESM loader hooks that mock every
"wix-*" module and map "backend/<name>" specifiers to src/backend/<name>.js,
so the real backend code can be imported and exercised with `node --test`
without a Wix Velo runtime and without node_modules.
SCOPE: tests only. Never imported by production code. G10 ASCII strict.
=============================================================================
*/

import { pathToFileURL } from 'node:url';
import { fileURLToPath, pathToFileURL as p2u } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/backend/tests -> src/backend
export const BACKEND_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Mock registry (mutable so tests can seed data / inspect calls)
// ---------------------------------------------------------------------------

export const harnessConfig = {
  // Generic stub returns "mock-secret" for every secret by default. Suites
  // that need real secret semantics (e.g. POS fiscal key >= 32 chars) set
  // this map before importing the module under test.
  secrets: new Map(),        // secretName -> string value
  currentMember: null,       // object {_id, loginEmail} or null
};

export const wixDataMock = {
  _store: new Map(),          // collectionName -> array of items
  _calls: [],                 // audit trail of operations
  _seed(collection, items) {
    // JSON round-trip would serialize Date instances to ISO strings and
    // break date comparisons in queries (.lt/_createdDate). Revive ISO
    // strings back into Date objects so seeded rows match live Velo types.
    const revived = JSON.parse(JSON.stringify(items), (key, value) => {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? value : d;
      }
      return value;
    });
    this._store.set(collection, revived);
  },
  _reset() {
    this._store.clear();
    this._calls.length = 0;
  },
  query(collection) {
    const rows = () => this._store.get(collection) || [];
    const state = { filters: [], limitN: 30 };
    const cmpValue = (v) => (v instanceof Date ? v.getTime() : v);
    // Real Velo semantics: filter methods (eq/in/lt...) return the same
    // WixDataQuery, so .eq(...).limit(1).count() chains legally. The mock
    // mirrors that by returning `q` from every builder method.
    const q = {};
    q.eq = (field, value) => { state.filters.push([field, value]); return q; };
    q.in = (field, values) => { state.filters.push([field, values]); return q; };
    q.ne = (field, value) => { state.filters.push(['!=', field, value]); return q; };
    q.lt = (field, value) => { state.filters.push(['<', field, value]); return q; };
    q.gt = (field, value) => { state.filters.push(['>', field, value]); return q; };
    q.le = (field, value) => { state.filters.push(['<=', field, value]); return q; };
    q.ge = (field, value) => { state.filters.push(['>=', field, value]); return q; };
    q.between = (field, low, high) => { state.filters.push(['range', field, low, high]); return q; };
    q.contains = (field, value) => { state.filters.push(['has', field, value]); return q; };
    q.hasSome = (field, values) => { state.filters.push(['some', field, values]); return q; };
    q.ascending = () => q;
    q.descending = () => q;
    q.limit = (n) => { state.limitN = n; return q; };
    const applyFilters = () => {
      let items = rows().slice();
      for (const f of state.filters) {
        if (f[0] === '!=') { items = items.filter((it) => it[f[1]] !== f[2]); }
        else if (f[0] === '<') { items = items.filter((it) => cmpValue(it[f[1]]) < cmpValue(f[2])); }
        else if (f[0] === '>') { items = items.filter((it) => cmpValue(it[f[1]]) > cmpValue(f[2])); }
        else if (f[0] === '<=') { items = items.filter((it) => cmpValue(it[f[1]]) <= cmpValue(f[2])); }
        else if (f[0] === '>=') { items = items.filter((it) => cmpValue(it[f[1]]) >= cmpValue(f[2])); }
        else if (f[0] === 'range') { items = items.filter((it) => cmpValue(it[f[1]]) >= cmpValue(f[2]) && cmpValue(it[f[1]]) <= cmpValue(f[3])); }
        // Velo "contains" = substring match on text fields; the mock must
        // honor both string substrings and array membership to mirror prod.
        else if (f[0] === 'has') { items = items.filter((it) => { const v = it[f[1]]; return typeof v === 'string' ? v.includes(f[2]) : Array.isArray(v) && v.includes(f[2]); }); }
        else if (f[0] === 'some') { items = items.filter((it) => Array.isArray(it[f[1]]) && it[f[1]].some((v) => f[2].includes(v))); }
        else if (Array.isArray(f[1])) { items = items.filter((it) => f[1].includes(it[f[0]])); }
        else { items = items.filter((it) => it[f[0]] === f[1]); }
      }
      return items;
    };
    q.count = async () => {
      this._calls.push({ op: 'query', collection });
      return applyFilters().length;
    };
    q.find = async () => {
      this._calls.push({ op: 'query', collection });
      const items = applyFilters().slice(0, state.limitN);
      return { items, total: items.length };
    };
    return q;
  },
  get: async (collection, id) => {
    wixDataMock._calls.push({ op: 'get', collection });
    const rows = wixDataMock._store.get(collection) || [];
    return rows.find((r) => r._id === id) || null;
  },
  queryReferencedItems: async (collection, itemId, field) => {
    wixDataMock._calls.push({ op: 'queryReferencedItems', collection });
    const source = (wixDataMock._store.get(collection) || []).find((row) => row._id === itemId);
    const ids = Array.isArray(source?.[field]) ? source[field] : [];
    return { items: ids.map((value) => typeof value === 'object' ? value : { _id: value }) };
  },
  insert: async (collection, item) => {
    wixDataMock._calls.push({ op: 'insert', collection });
    const rows = wixDataMock._store.get(collection) || [];
    // Real Velo semantics: inserting a row whose _id already exists in the
    // collection raises WDE0123. The slot-lock mechanism (_lockSlotKeyOrFail)
    // depends on this to detect "lock held by another owner"; a mock that
    // silently allowed duplicates made locks always succeed.
    if (item && item._id && rows.some((r) => r._id === item._id)) {
      const dup = new Error('WDE0123: Item with the same _id already exists');
      dup.name = 'DuplicatedItemError';
      throw dup;
    }
    const saved = { _id: item && item._id ? item._id : 'mock_' + (rows.length + 1), ...item };
    rows.push(saved);
    wixDataMock._store.set(collection, rows);
    return saved;
  },
  save: async (collection, item) => {
    // Real Velo semantics: save() upserts by _id. eventLog._getNextSequenceInternal
    // persists the fiscal sequence doc with save(); without this method the
    // POS ledger flow throws TypeError at runtime under test.
    wixDataMock._calls.push({ op: 'save', collection });
    const rows = wixDataMock._store.get(collection) || [];
    const idx = rows.findIndex((r) => r._id === item._id);
    if (idx >= 0) rows[idx] = item; else rows.push(item);
    wixDataMock._store.set(collection, rows);
    return item;
  },
  update: async (collection, item) => {
    wixDataMock._calls.push({ op: 'update', collection });
    const rows = wixDataMock._store.get(collection) || [];
    const idx = rows.findIndex((r) => r._id === item._id);
    if (idx >= 0) rows[idx] = item; else rows.push(item);
    return item;
  },
  remove: async (collection, item) => {
    wixDataMock._calls.push({ op: 'remove', collection });
    // Real Velo semantics: remove() deletes the row (accepts _id or object).
    // Purge crons (cleanAuditLogs et al.) assert against store state after
    // running, so the mock must actually mutate it.
    const id = (item && typeof item === 'object') ? item._id : item;
    const rows = wixDataMock._store.get(collection) || [];
    wixDataMock._store.set(collection, rows.filter((r) => r._id !== id));
    return item;
  },
};

export const mocks = {
  wixData: wixDataMock,
  logger: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    _calls: [],
  },
};

const GENERIC_STUB_SOURCE = `
import { harnessConfig } from ${JSON.stringify(p2u(path.join(BACKEND_DIR, 'tests/loader.mjs')).href.replace(/\\\\/g, '/'))};
const fnProxy = new Proxy(function () {}, {
  get: (t, p) => {
    if (p === 'then') return undefined;
    return fnProxy;
  },
  apply: () => fnProxy,
});
export const webMethod = (...args) => {
  // Real Velo semantics: webMethod(perm..., handler) returns the handler
  // (optionally wrapped). Tests call the exported handlers directly, so the
  // last function argument must be returned as-is.
  const fns = args.filter((a) => typeof a === 'function');
  return fns.length ? fns[fns.length - 1] : (handlerFn) => handlerFn;
};
export const Permissions = { Admin: 'ADMIN', SiteMember: 'MEMBER', Public: 'PUBLIC', Anyone: 'ANYONE' };
export const currentMember = fnProxy;
export const locations = fnProxy;
export const bookingsBackend = fnProxy;
export const paymentsBackend = fnProxy;
export const transactions = fnProxy;
export const media = fnProxy;
export const crypto = fnProxy;
export const members = { getCurrentMember: async () => harnessConfig.currentMember };
export const secrets = { getSecretValue: async (name) => (harnessConfig.secrets.has(name) ? harnessConfig.secrets.get(name) : "mock-secret") };
// auth.elevate (@wix/essentials): identidad, igual que elevate (ver abajo).
export const auth = { elevate: (fn) => fn };
// Named SDK exports imported by backend code (offline stubs):
export const availabilityTimeSlots = fnProxy;
export const bookings = fnProxy;
export const checkout = fnProxy;
export const orders = fnProxy;
export const elevate = fnProxy;
export const createClient = () => fnProxy;
export const getSecret = async () => "mock-secret";
export function _namedExportFallback(name) { return fnProxy; }
const handler = { get: (t, p) => {
  if (p === 'then') return undefined;
  if (p === 'webMethod') return webMethod;
  if (p === 'Permissions') return Permissions;
  if (p === 'default') return fnProxy;
  if (!(p in t)) { t[p] = fnProxy; }
  return t[p];
} };
const mod = new Proxy({ default: fnProxy }, handler);
export default mod.default;
`;

const WIX_DATA_SOURCE = `
import { wixDataMock } from ${JSON.stringify(p2u(path.join(BACKEND_DIR, 'tests/loader.mjs')).href.replace(/\\/g, '/'))};
export const items = wixDataMock;
export default wixDataMock;
`;

// ---------------------------------------------------------------------------
// resolve/load hooks (used when run WITH --experimental-loader)
// ---------------------------------------------------------------------------

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('wix-') || specifier.startsWith('@wix/')) {
    // Offline harness: every Wix SDK package resolves to the generic stub.
    // wix-data keeps its dedicated in-memory mock below.
    return { url: 'mock:' + specifier, shortCircuit: true };
  }
  // Only the legacy adapter is redirected to the in-memory mock (it exposes
  // the default wixData-style interface the mock implements).
  // backend/dataAccess.js is REAL DAL code with named exports (CONSISTENCY,
  // queryFirstItem, ...) that tests exercise directly; redirecting it broke
  // every importer with "does not provide an export named 'CONSISTENCY'".
  if (specifier === 'backend/dataLegacyAdapter' ||
      specifier.endsWith('/dataLegacyAdapter.js')) {
    return { url: 'mock:wix-data', shortCircuit: true };
  }
  if (specifier.startsWith('backend/') || specifier.startsWith('public/')) {
    const rel = specifier.includes('/') ? specifier.slice(specifier.indexOf('/') + 1) : specifier;
    const rootDir = specifier.startsWith('public/') ? path.join(BACKEND_DIR, '..', 'public') : BACKEND_DIR;
    const abs = path.join(rootDir, rel.endsWith('.js') ? rel : rel + '.js');
    if (!fs.existsSync(abs)) {
      throw new Error('loader.mjs: cannot resolve Velo alias specifier ' + specifier + ' -> ' + abs);
    }
    return { url: pathToFileURL(abs).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('mock:wix-data') || url === 'mock:@wix/data') {
    return { format: 'module', source: WIX_DATA_SOURCE, shortCircuit: true };
  }
  if (url.startsWith('mock:')) {
    return { format: 'module', source: GENERIC_STUB_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}

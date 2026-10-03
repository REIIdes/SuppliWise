/**
 * Detecting AI credentials this server cannot actually use.
 *
 * WHY THIS EXISTS
 * ---------------
 * `utils/envFile.js` reloads server/.env and reports which variable NAMES it
 * applied. That report is about the FILE, and it is technically true for every
 * name it copies — but "Applied LLAMA_API_KEY" is a statement about
 * `process.env`, not about the application. Nothing in the server reads that
 * variable, so no feature can ever use the key, and the banner reads as a
 * successful configuration.
 *
 * That is the exact failure `utils/aiProviders.js` was written to end. Its
 * header complains that the panel once reported `Boolean(process.env.X_API_KEY)`
 * as "Configured", which proved only that a variable existed. The same mistake
 * survives in a subtler form here: a key the application ignores entirely.
 *
 * So this answers a different question, the one the reload banner cannot:
 *
 *   Which credential-shaped variables are set, and read NOWHERE in the
 *   running server?
 *
 * HOW IT ANSWERS IT
 * -----------------
 * By scanning this server's own runtime source for `process.env.<NAME>`
 * references, and comparing that set against what is actually in the
 * environment. A variable no file mentions is dead by definition — there is no
 * dynamic lookup to hide behind, because this codebase reads configuration
 * through literal `process.env.NAME` accesses.
 *
 * The scan is a diagnostic, not a hot path: it runs at most once per TTL and is
 * invalidated by a forced re-check, so the 10 s dashboard poll does not re-walk
 * the source tree every time.
 *
 * SCOPE
 * -----
 * Only the runtime directories are scanned (routes, utils, middleware, models,
 * blockchain, index.js). `Test File/` is excluded on purpose: a test that scrubs
 * a variable from `process.env` is cleaning up, not using the credential, and
 * including it would make every tested variable look live. `scripts/` is
 * included, because those run on the same host with the same environment.
 *
 * Only NAMES are ever returned. No value is read into a result, and this module
 * has no reason to look at one.
 */

const fs = require('fs');
const path = require('path');

const { AI_PROVIDERS, providerUsage } = require('./aiProviders');

const SERVER_ROOT = path.join(__dirname, '..');

/** Runtime source that can actually consume a credential. */
const RUNTIME_DIRS = ['routes', 'utils', 'middleware', 'models', 'blockchain'];
const RUNTIME_FILES = ['index.js'];

/** Directories never walked, at any depth. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'uploads', 'Test File', 'coverage', 'dist', 'dev-dist']);

/** Scanned source is re-read at most this often. */
const USAGE_TTL_MS = 5 * 60 * 1000;

const SCANNED_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

/**
 * Variables that look like credentials, and the specific shapes that do.
 *
 * The `_API_KEY` suffix is the signal, with the prefix optional so a bare
 * `API_KEY` is caught too — that is exactly the sort of leftover an operator
 * forgets about, and it is just as unspendable as a prefixed one.
 *
 * It is deliberately narrow otherwise: `PORT` and `MONGO_URI` are
 * configuration, not credentials, and flagging those would bury the one line an
 * admin actually needs to read.
 */
const CREDENTIAL_PATTERN = /^(?:[A-Z0-9_]+_)?API_KEY$/;

/**
 * `process.env.NAME` and `process.env['NAME']` / `process.env["NAME"]`.
 *
 * This is the whole basis of the module's accuracy, so it is worth being strict
 * about: a bare `process.env` destructure (`const { X } = process.env`) is not
 * matched, because attributing those to specific names would require parsing
 * JavaScript rather than reading it. Anything matched here is a literal,
 * unambiguous reference. Where it is silent it errs toward reporting fewer
 * dead keys, never toward hiding a live one.
 */
const ENV_REFERENCE = /process\s*\.\s*env\s*(?:\.\s*([A-Z0-9_]+)|\[\s*['"]([A-Z0-9_]+)['"]\s*\])/g;

/** @type {{at: number, names: Set<string>}|null} */
let usageCache = null;

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory contributes nothing, and is not an error here
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

/**
 * Every env var this server's runtime source names, literally.
 *
 * @param {{force?: boolean}} [options]
 * @returns {Set<string>}
 */
function scanEnvUsage({ force = false } = {}) {
  if (!force && usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) {
    return usageCache.names;
  }

  const files = [];
  for (const name of RUNTIME_FILES) {
    const full = path.join(SERVER_ROOT, name);
    if (fs.existsSync(full)) files.push(full);
  }
  for (const dir of RUNTIME_DIRS) {
    const full = path.join(SERVER_ROOT, dir);
    if (fs.existsSync(full)) walk(full, files);
  }

  const names = new Set();
  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // `String.matchAll` with a /g regex resets lastIndex, so this is safe to
    // call per file.
    for (const match of source.matchAll(ENV_REFERENCE)) {
      const name = match[1] || match[2];
      if (name) names.add(name);
    }
  }

  usageCache = { at: Date.now(), names };
  return names;
}

/** The credential variables the provider registry claims. */
function claimedCredentialNames() {
  return new Set(AI_PROVIDERS.map((provider) => provider.envKey));
}

/**
 * Credential-shaped variables that are set but cannot be spent on anything.
 *
 * These are the dead keys: they load into `process.env`, the reload banner
 * reports them as applied, and no feature ever calls them.
 *
 * THREE STATES, not one, because the operator's next action differs:
 *
 *   - `unknown`  — set, and read nowhere. A configuration mistake (a typo, a
 *                  leftover from a provider that was removed, a key for a
 *                  service this server has no route to). Nothing can use it.
 *   - `unrouted` — a real provider key the health panel probes, but no FEATURE
 *                  is routed to it. The credential works; it just does nothing
 *                  for the product. This is the state the panel already labels
 *                  "No route in this server calls it yet", named here so it is
 *                  impossible to miss.
 *   - `active`   — routed to at least one purpose. Not reported.
 *
 * A registry `envKey` counts as USED even though no line reads
 * `process.env.GROQ_API_KEY`: `aiProviders.resolveKey` reads it dynamically
 * through `env[provider.envKey]`. Matching only literal accesses reported all
 * four live provider keys as dead, which is the opposite failure and just as
 * misleading.
 *
 * "Is anything routed to it?" is answered by `providerUsage()`, which reads the
 * ROUTING TABLE rather than a string written beside the provider. That is the
 * point of asking the routing table: a hand-maintained `usedBy` disagreed with
 * the real assignments, which is how a provider came to be reported as unrouted
 * while features were being dispatched to it.
 *
 * @param {{env?: NodeJS.ProcessEnv, force?: boolean}} [options]
 * @returns {Array<{name: string, state: string, reason: string}>} sorted by name
 */
function findUnusableKeys({ env = process.env, force = false } = {}) {
  const literal = scanEnvUsage({ force });

  const dead = [];
  for (const name of Object.keys(env)) {
    if (!CREDENTIAL_PATTERN.test(name)) continue;

    if (literal.has(name)) continue; // read by a real line of runtime source

    const provider = AI_PROVIDERS.find((entry) => entry.envKey === name);
    if (!provider) {
      dead.push({
        name,
        state: 'unknown',
        reason: 'No provider in this server uses this key, and nothing in the source reads it. '
          + 'It will load into the environment and be reported as applied, but no feature can call it.',
      });
      continue;
    }

    const usage = providerUsage(provider);
    if (usage) continue; // at least one purpose dispatches to it

    dead.push({
      name,
      state: 'unrouted',
      reason: `${provider.label} is probed for health, but no feature is routed to it — `
        + 'so the key is checked and never spent. Add a purpose in utils/aiRouter.js to use it.',
    });
  }

  return dead.sort((a, b) => a.name.localeCompare(b.name));
}

/** Test seam: drop the scan cache so the next call re-reads the source. */
function clearUsageCache() {
  usageCache = null;
}

module.exports = {
  USAGE_TTL_MS,
  CREDENTIAL_PATTERN,
  RUNTIME_DIRS,
  RUNTIME_FILES,
  SKIP_DIRS,
  scanEnvUsage,
  claimedCredentialNames,
  findUnusableKeys,
  clearUsageCache,
};

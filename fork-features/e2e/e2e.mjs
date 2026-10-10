#!/usr/bin/env node
// MailFlow local end-to-end environment. Usage and the resource model: README.md beside this file.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const COMPOSE_FILE = join(HERE, 'compose.yml');

const PG_CONTAINER = 'shared-postgres';
const REDIS_CONTAINER = 'shared-redis';
const PG_HOST_PORT = 65432;
const REDIS_HOST_PORT = 56379;
// shared-redis runs with --databases 64. Slot N owns Redis logical DB N and host port
// PORT_BASE + N; logical DB 0 is never handed out.
const MAX_SLOT = 63;
const PORT_BASE = 38700;
// Session-level advisory lock serialising every create/drop of an instance database, so
// the slot recorded in the database comment cannot be taken twice.
const SLOT_LOCK = 'mailflow-e2e-slots';
const SLOT_COMMENT = /^mailflow-e2e slot=(\d+)$/;

const IMAP_PORT = 31993;
const IMAP_PASSWORD = 'e2e-imap-password';
const ENDPOINT_HOST = { full: 'dovecot', degraded: 'dovecot-degraded' };
const JEV_AUTH_FILE = join(homedir(), '.commandcode', 'auth.json');

class Failure extends Error {}

function fail(message) {
  throw new Failure(message);
}

// ── Instance identity ────────────────────────────────────────────────────────

function instanceFromEnv() {
  const raw = process.env.E2E_INSTANCE ?? 'default';
  const instance = raw.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_]{0,39}$/.test(instance)) {
    fail(`E2E_INSTANCE must be 1-40 letters, digits or underscores, starting with a letter or digit (got ${JSON.stringify(raw)})`);
  }
  return {
    name: instance,
    project: `mailflow-e2e-${instance}`,
    database: `mailflow_e2e_${instance}`,
  };
}

// Test-only values, derived from the instance name so a stopped instance comes back with
// the same database login and can still decrypt the IMAP passwords it stored. They guard
// nothing but a throwaway database bound to 127.0.0.1.
function derived(purpose, inst) {
  return createHash('sha256').update(`mailflow-e2e:${purpose}:${inst.name}`).digest('hex');
}

// ── Process helpers ──────────────────────────────────────────────────────────

function run(cmd, args, { input, env, inherit = false, allowFailure = false } = {}) {
  const res = spawnSync(cmd, args, {
    input,
    env: env ?? process.env,
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) fail(`${cmd}: ${res.error.message}`);
  if (res.status !== 0 && !allowFailure) {
    const detail = inherit ? '' : `\n${String(res.stderr || res.stdout).trim()}`;
    fail(`${cmd} ${args.slice(0, 3).join(' ')} … exited ${res.status}${detail}`);
  }
  return { status: res.status, stdout: inherit ? '' : String(res.stdout), stderr: inherit ? '' : String(res.stderr) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function psql(script, { database = 'postgres', vars = {} } = {}) {
  const args = ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', database, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  return run('docker', args, { input: script }).stdout.trim();
}

function redis(slot, ...command) {
  return run('docker', ['exec', REDIS_CONTAINER, 'redis-cli', '-n', String(slot), ...command]).stdout.trim();
}

function gitHead() {
  return run('git', ['-C', REPO, 'rev-parse', 'HEAD']).stdout.trim();
}

function gitDirty() {
  return run('git', ['-C', REPO, 'status', '--porcelain']).stdout.trim() !== '';
}

function readJevKey() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(JEV_AUTH_FILE, 'utf8'));
  } catch (err) {
    fail(`cannot read ${JEV_AUTH_FILE}: ${err.code || err.name}`);
  }
  if (typeof parsed?.apiKey !== 'string' || parsed.apiKey === '') fail(`${JEV_AUTH_FILE} has no apiKey`);
  return parsed.apiKey;
}

// ── Shared dependencies (long-lived; started when stopped, never stopped here) ──

async function ensureShared() {
  for (const [container, ready] of [
    [PG_CONTAINER, ['pg_isready', '-q', '-U', 'postgres']],
    [REDIS_CONTAINER, ['redis-cli', 'ping']],
  ]) {
    const state = run('docker', ['inspect', '-f', '{{.State.Running}}', container], { allowFailure: true });
    if (state.status !== 0) {
      fail(`${container} does not exist. It is a long-lived shared container registered in ~/Ext/work/orbstack/README.md; create it from there.`);
    }
    if (state.stdout.trim() !== 'true') run('docker', ['start', container]);
    for (let i = 0; ; i++) {
      if (run('docker', ['exec', container, ...ready], { allowFailure: true }).status === 0) break;
      if (i >= 60) fail(`${container} did not become ready`);
      await sleep(500);
    }
  }
}

// ── Instance database and slot ───────────────────────────────────────────────

function slotOf(inst) {
  const row = psql(`SELECT 'db:' || coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = :'db';`, { vars: { db: inst.database } });
  if (row === '') return null;
  const comment = row.slice('db:'.length);
  const m = SLOT_COMMENT.exec(comment);
  if (!m) fail(`database ${inst.database} exists but carries no mailflow-e2e slot comment (${JSON.stringify(comment)})`);
  return Number(m[1]);
}

// Creates role + database when missing and records the slot as the database comment, all
// inside one psql session holding SLOT_LOCK. Returns { slot, created }.
function ensureInstanceDatabase(inst) {
  const out = psql(`
SELECT pg_advisory_lock(hashtext('${SLOT_LOCK}')) \\g /dev/null
SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') AS existed \\gset
\\if :existed
\\else
  SELECT s AS slot FROM generate_series(1, ${MAX_SLOT}) s
   WHERE s NOT IN (
     SELECT substring(shobj_description(oid, 'pg_database') FROM '^mailflow-e2e slot=([0-9]+)$')::int
       FROM pg_database
      WHERE shobj_description(oid, 'pg_database') ~ '^mailflow-e2e slot=[0-9]+$')
   ORDER BY s LIMIT 1 \\gset
  \\if :{?slot}
  \\else
    \\echo NO_FREE_SLOT
    \\quit
  \\endif
  SELECT format('CREATE ROLE %I LOGIN', :'db') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'db') \\gexec
  SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'db') \\gexec
  SELECT format('COMMENT ON DATABASE %I IS %L', :'db', 'mailflow-e2e slot=' || :slot) \\gexec
  SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', :'db') \\gexec
\\endif
ALTER ROLE :"db" LOGIN PASSWORD :'pw';
SELECT CASE WHEN :'existed' THEN 'existing' ELSE 'created' END;
`, { vars: { db: inst.database, pw: derived('db-password', inst).slice(0, 32) } });
  if (out.includes('NO_FREE_SLOT')) fail(`all ${MAX_SLOT} instance slots are taken; destroy an unused instance first`);
  const created = out.split('\n').at(-1) === 'created';
  const slot = slotOf(inst);
  if (created) redis(slot, 'FLUSHDB');
  return { slot, created };
}

// Drops and recreates the database under the same slot, holding SLOT_LOCK throughout.
function recreateInstanceDatabase(inst, slot) {
  psql(`
SELECT pg_advisory_lock(hashtext('${SLOT_LOCK}')) \\g /dev/null
SELECT format('DROP DATABASE %I WITH (FORCE)', :'db') \\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'db') \\gexec
SELECT format('COMMENT ON DATABASE %I IS %L', :'db', 'mailflow-e2e slot=' || :slot) \\gexec
SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', :'db') \\gexec
`, { vars: { db: inst.database, slot } });
}

function dropInstanceDatabase(inst) {
  psql(`
SELECT pg_advisory_lock(hashtext('${SLOT_LOCK}')) \\g /dev/null
SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', :'db') \\gexec
SELECT format('DROP ROLE IF EXISTS %I', :'db') \\gexec
`, { vars: { db: inst.database } });
}

function requireSlot(inst) {
  const slot = slotOf(inst);
  if (slot === null) fail(`instance ${inst.name} does not exist (no database ${inst.database}); start it with: E2E_INSTANCE=${inst.name} node fork-features/e2e/e2e.mjs up`);
  return slot;
}

// ── Compose ──────────────────────────────────────────────────────────────────

const appUrl = (slot) => `http://localhost:${PORT_BASE + slot}`;

// JEV_API_KEY is left out, even when the caller's shell exports one: compose renders the
// resolved environment in `config` output, so only the `up` that creates the backend gets
// the key (composeUp).
function composeEnv(inst, slot) {
  const { JEV_API_KEY: _withheld, ...inherited } = process.env;
  return {
    ...inherited,
    E2E_GIT_SHA: gitHead(),
    E2E_FRONTEND_PORT: String(PORT_BASE + slot),
    E2E_APP_URL: appUrl(slot),
    E2E_SESSION_SECRET: derived('session-secret', inst),
    E2E_ENCRYPTION_KEY: derived('encryption-key', inst),
    E2E_DB_NAME: inst.database,
    E2E_DB_PASSWORD: derived('db-password', inst).slice(0, 32),
    E2E_REDIS_URL: `redis://host.docker.internal:${REDIS_HOST_PORT}/${slot}`,
    E2E_IMAP_PASSWORD: IMAP_PASSWORD,
  };
}

function compose(inst, slot, args, { env = composeEnv(inst, slot), ...opts } = {}) {
  return run('docker', ['compose', '-p', inst.project, '-f', COMPOSE_FILE, ...args], { env, inherit: true, ...opts });
}

// The one compose call that creates or recreates containers, and so the only one whose
// environment carries the key.
function composeUp(inst, slot) {
  compose(inst, slot, ['up', '-d', '--build', '--wait', '--remove-orphans'], {
    env: { ...composeEnv(inst, slot), JEV_API_KEY: readJevKey() },
  });
}

// Project-scoped teardown needs only the project label, not the compose file.
function composeDown(inst, extra = []) {
  run('docker', ['compose', '-p', inst.project, 'down', '--remove-orphans', ...extra], { inherit: true });
}

function serviceContainer(inst, service) {
  const id = run('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${inst.project}`, '--filter', `label=com.docker.compose.service=${service}`]).stdout.trim();
  return id.split('\n')[0] || null;
}

function projectContainers(inst) {
  return run('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${inst.project}`, '--format', '{{.Names}}\t{{.Status}}']).stdout.trim();
}

// ── up ───────────────────────────────────────────────────────────────────────

async function waitForApp(inst, slot) {
  const base = appUrl(slot);
  const head = gitHead();
  let last = 'no response';
  for (let i = 0; i < 90; i++) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      const version = await (await fetch(`${base}/api/version`)).json();
      if (health?.status === 'ok' && version?.sha === head) return version;
      last = `health=${JSON.stringify(health)} version=${JSON.stringify(version)}`;
    } catch (err) {
      last = err.cause?.code || err.message;
    }
    await sleep(1000);
  }
  run('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${inst.project}`], { inherit: true, allowFailure: true });
  const backend = run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${inst.project}`, '--filter', 'label=com.docker.compose.service=backend']).stdout.trim();
  if (backend) run('docker', ['logs', '--tail', '50', backend.split('\n')[0]], { inherit: true, allowFailure: true });
  fail(`${base} did not serve /api/health ok with /api/version sha ${head} (last: ${last})`);
}

async function up(inst) {
  await ensureShared();
  if (gitDirty()) console.error('warning: the checkout has uncommitted changes; the images include them, but BUILD_SHA reports HEAD');
  const { slot, created } = ensureInstanceDatabase(inst);
  console.log(`${created ? 'created' : 'reusing'} database ${inst.database} (slot ${slot})`);
  composeUp(inst, slot);
  await waitForApp(inst, slot);
  status(inst);
}

// ── status ───────────────────────────────────────────────────────────────────

function status(inst) {
  const slot = requireSlot(inst);
  const containers = projectContainers(inst);
  console.log(`
instance    ${inst.name}
project     ${inst.project}
url         ${appUrl(slot)}   (open with "localhost", not 127.0.0.1: APP_URL must match the browser origin)
database    ${inst.database} on ${PG_CONTAINER} (127.0.0.1:${PG_HOST_PORT})
redis       ${REDIS_CONTAINER} logical DB ${slot} (127.0.0.1:${REDIS_HOST_PORT})
imap        full: dovecot:${IMAP_PORT}  degraded: dovecot-degraded:${IMAP_PORT}  (implicit TLS, self-signed; any user name, password ${IMAP_PASSWORD})
containers
${containers ? containers.replace(/^/gm, '  ') : '  (none running)'}`);
}

// ── seed ─────────────────────────────────────────────────────────────────────

function parseSeedArgs(argv) {
  const opts = { mailUser: 'alice', folder: 'INBOX', endpoint: 'full', mfUser: 'e2e', mfPassword: 'e2e-mailflow-password', timeout: 120, files: [] };
  const flags = { '--mail-user': 'mailUser', '--folder': 'folder', '--endpoint': 'endpoint', '--mf-user': 'mfUser', '--mf-password': 'mfPassword', '--timeout': 'timeout' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg in flags) {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      opts[flags[arg]] = argv[++i];
    } else if (arg.startsWith('--')) {
      fail(`unknown seed option ${arg}`);
    } else {
      opts.files.push(arg);
    }
  }
  if (!(opts.endpoint in ENDPOINT_HOST)) fail(`--endpoint must be one of ${Object.keys(ENDPOINT_HOST).join(', ')}`);
  if (!/^[A-Za-z0-9._-]+$/.test(opts.mailUser)) fail('--mail-user may contain only letters, digits, ".", "_" and "-"');
  opts.mailUser = opts.mailUser.toLowerCase();
  opts.timeout = Number(opts.timeout);
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) fail('--timeout must be a positive number of seconds');
  return opts;
}

function fixtureFiles(paths) {
  const files = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (statSync(abs).isDirectory()) {
      files.push(...readdirSync(abs).filter((f) => f.endsWith('.eml')).sort().map((f) => join(abs, f)));
    } else {
      files.push(abs);
    }
  }
  return files;
}

// Bytes are passed through untouched apart from line endings, which RFC 5322 requires to be
// CRLF on the wire. latin1 maps every byte to one code unit, so 8-bit headers survive.
function loadMessage(file) {
  const bytes = Buffer.from(readFileSync(file).toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
  const text = bytes.toString('latin1');
  const headerEnd = text.indexOf('\r\n\r\n');
  const header = (headerEnd === -1 ? text : text.slice(0, headerEnd)).replace(/\r\n[ \t]+/g, ' ');
  const m = /^message-id:[ \t]*(\S.*?)[ \t]*$/im.exec(header);
  return { file, bytes, messageId: m ? m[1] : null };
}

const imapQuote = (s) => `"${s.replace(/[\\"]/g, '\\$&')}"`;
const imapUrlPath = (folder) => folder.split('/').map(encodeURIComponent).join('/');

function dovecotCurl(dovecot, opts, args, { input, allowFailure = false } = {}) {
  return run('docker', ['exec', '-i', dovecot, 'curl', '-sS', '--ssl-reqd', '-k', '-u', `${opts.mailUser}:${IMAP_PASSWORD}`, ...args], { input, allowFailure });
}

function appendMessages(dovecot, opts, messages) {
  const root = `imaps://127.0.0.1:${IMAP_PORT}/`;
  const listed = dovecotCurl(dovecot, opts, [root, '-X', `LIST "" ${imapQuote(opts.folder)}`]).stdout.trim();
  if (listed === '') {
    dovecotCurl(dovecot, opts, [root, '-X', `CREATE ${imapQuote(opts.folder)}`]);
    console.log(`created folder ${opts.folder} for ${opts.mailUser}`);
  }
  // curl's IMAP APPEND needs the message size up front, so each message is staged in the
  // container's /run/e2e tmpfs first.
  const staged = `/run/e2e/seed-${randomBytes(6).toString('hex')}.eml`;
  for (const msg of messages) {
    run('docker', ['exec', '-i', dovecot, 'curl', '-sS', '-o', staged, 'file:///dev/stdin'], { input: msg.bytes });
    dovecotCurl(dovecot, opts, ['-T', staged, `${root}${imapUrlPath(opts.folder)}`]);
    console.log(`appended ${msg.file} → ${opts.mailUser}/${opts.folder}${msg.messageId ? ` (Message-ID ${msg.messageId})` : ' (no Message-ID)'}`);
  }
}

class MailflowClient {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  async request(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-Requested-With'] = 'XMLHttpRequest';
    const res = await fetch(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
    return { status: res.status, json, text };
  }

  async expect(method, path, body, ok = [200]) {
    const res = await this.request(method, path, body);
    if (!ok.includes(res.status)) fail(`${method} ${path} → ${res.status} ${res.json?.error ?? res.text.slice(0, 200)}`);
    return res.json;
  }
}

async function signIn(client, opts) {
  const creds = { username: opts.mfUser, password: opts.mfPassword };
  const login = await client.request('POST', '/api/auth/login', creds);
  if (login.status === 200 && !login.json?.user) fail(`login of ${opts.mfUser} needs an extra step (${JSON.stringify(login.json)}); use a MailFlow user without MFA`);
  if (login.status === 401) {
    await client.expect('POST', '/api/auth/register', creds);
    console.log(`registered MailFlow user ${opts.mfUser}`);
  } else if (login.status !== 200) {
    fail(`POST /api/auth/login → ${login.status} ${login.json?.error ?? ''}`);
  } else {
    console.log(`logged in as MailFlow user ${opts.mfUser}`);
  }
  return (await client.expect('GET', '/api/auth/me')).user;
}

async function ensureAccount(client, user, opts) {
  const host = ENDPOINT_HOST[opts.endpoint];
  if (user.isAdmin) {
    // Dovecot sits on a private address behind a self-signed certificate.
    await client.expect('PATCH', '/api/admin/settings', { allow_private_hosts: true, allow_insecure_tls: true });
  }
  const accounts = await client.expect('GET', '/api/accounts');
  const existing = accounts.find((a) => a.imap_host === host && a.auth_user === opts.mailUser);
  if (existing) {
    console.log(`reusing account ${existing.name} (${existing.id})`);
    return existing;
  }
  const account = await client.expect('POST', '/api/accounts', {
    name: `${opts.mailUser} (${opts.endpoint})`,
    email_address: `${opts.mailUser}@e2e.test`,
    imap_host: host,
    imap_port: IMAP_PORT,
    imap_skip_tls_verify: true,
    auth_user: opts.mailUser,
    auth_pass: IMAP_PASSWORD,
    signature_enabled: false,
  });
  console.log(`added account ${account.name} (${account.id}) → ${host}:${IMAP_PORT}`);
  return account;
}

async function waitForIngest(inst, account, opts, messages) {
  const wanted = messages.filter((m) => m.messageId);
  const untracked = messages.length - wanted.length;
  if (untracked) console.log(`${untracked} message(s) without Message-ID are not tracked`);
  if (!wanted.length) return;
  const bare = (id) => id.replace(/^<|>$/g, '');
  const deadline = Date.now() + opts.timeout * 1000;
  for (;;) {
    const rows = psql(`SELECT message_id FROM messages WHERE account_id = :'acct' AND folder = :'folder' AND NOT is_deleted;`, {
      database: inst.database, vars: { acct: account.id, folder: opts.folder },
    });
    const present = new Set(rows.split('\n').filter(Boolean).map(bare));
    const missing = wanted.filter((m) => !present.has(bare(m.messageId)));
    if (!missing.length) {
      console.log(`MailFlow shows all ${wanted.length} tracked message(s) in ${account.name} / ${opts.folder}`);
      return;
    }
    if (Date.now() > deadline) fail(`after ${opts.timeout}s MailFlow still lacks ${missing.map((m) => m.messageId).join(', ')} in ${opts.folder}`);
    await sleep(1000);
  }
}

async function seed(inst, argv) {
  const opts = parseSeedArgs(argv);
  const slot = requireSlot(inst);
  const dovecot = serviceContainer(inst, 'dovecot');
  if (!dovecot || !serviceContainer(inst, 'backend')) fail(`instance ${inst.name} is not running; start it with up`);
  const messages = fixtureFiles(opts.files).map(loadMessage);
  if (messages.length) appendMessages(dovecot, opts, messages);
  const client = new MailflowClient(appUrl(slot));
  const user = await signIn(client, opts);
  const account = await ensureAccount(client, user, opts);
  await waitForIngest(inst, account, opts, messages);
}

// ── stop / reset / destroy ───────────────────────────────────────────────────

function stop(inst) {
  composeDown(inst);
  console.log(`removed the containers of ${inst.project}; database ${inst.database} and its Redis logical DB are kept`);
}

async function reset(inst) {
  await ensureShared();
  const slot = requireSlot(inst);
  const wasRunning = projectContainers(inst) !== '';
  if (wasRunning) composeDown(inst);
  recreateInstanceDatabase(inst, slot);
  redis(slot, 'FLUSHDB');
  console.log(`recreated database ${inst.database} and flushed Redis logical DB ${slot}`);
  if (wasRunning) await up(inst);
}

async function destroy(inst) {
  await ensureShared();
  const slot = slotOf(inst);
  composeDown(inst, ['--rmi', 'local']);
  dropInstanceDatabase(inst);
  if (slot !== null) redis(slot, 'FLUSHDB');
  console.log(`destroyed ${inst.name}: containers, network and images of ${inst.project}, database and role ${inst.database}${slot !== null ? `, Redis logical DB ${slot} flushed` : ''}`);
}

// ── rawlog / compose passthrough ─────────────────────────────────────────────

function rawlog(inst) {
  const dovecot = serviceContainer(inst, 'dovecot');
  if (!dovecot) fail(`instance ${inst.name} is not running`);
  const files = run('docker', ['exec', dovecot, 'curl', '-sS', 'file:///var/log/rawlog/']).stdout.split('\n').filter(Boolean).sort();
  if (!files.length) {
    console.log('no rawlog files; start the instance with E2E_DOVECOT_RAWLOG=1 to record IMAP sessions');
    return;
  }
  for (const f of files) {
    process.stdout.write(`==> ${f} <==\n`);
    process.stdout.write(run('docker', ['exec', dovecot, 'curl', '-sS', `file:///var/log/rawlog/${f}`]).stdout);
  }
}

// Read-only subcommands only, and only as the first argument: Compose accepts its global
// options (-f, --env-file, --project-directory, -p) only before the subcommand, so the
// project and environment chosen here cannot be swapped. They run without the key
// (composeEnv), so `config` renders JEV_API_KEY without a value; `config --environment`,
// which prints the whole interpolation environment, is refused anyway. Anything that creates
// containers (up, create, run) would give the backend no key, and exec/run can print a
// container's environment, so the rest is refused rather than forwarded.
const PASSTHROUGH = ['ps', 'logs', 'top', 'config', 'images', 'port'];

function composePassthrough(inst, argv) {
  const [sub] = argv;
  if (!PASSTHROUGH.includes(sub)) {
    fail(`compose passes through only ${PASSTHROUGH.join(', ')}, as the first argument (got ${sub === undefined ? 'nothing' : JSON.stringify(sub)}). Start or recreate containers with up, remove them with stop or destroy; see fork-features/e2e/README.md.`);
  }
  if (sub === 'config' && argv.some((a) => a === '--environment' || a.startsWith('--environment='))) {
    fail('compose config --environment is refused: it prints the environment of the compose process');
  }
  const res = compose(inst, requireSlot(inst), argv, { allowFailure: true });
  process.exitCode = res.status;
}

// ── main ─────────────────────────────────────────────────────────────────────

const USAGE = `usage: [E2E_INSTANCE=<name>] node fork-features/e2e/e2e.mjs <command>
  up                       build the current checkout and start (or update) the instance
  seed [options] [eml…]    APPEND .eml files to Dovecot and add the account in MailFlow
  status                   print URL, database, Redis DB and containers
  stop                     remove the instance's containers; keep its database
  reset                    recreate its database and Redis DB (restarts it if running)
  destroy                  remove containers, images, database, role and Redis DB
  rawlog                   print the Dovecot IMAP rawlogs (needs E2E_DOVECOT_RAWLOG=1 at up)
  compose <sub> [args…]    read-only docker compose for this instance (ps, logs, top, config,
                           images, port), e.g. "compose logs backend"
See fork-features/e2e/README.md.`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const inst = instanceFromEnv();
  switch (command) {
    case 'up': return up(inst);
    case 'seed': return seed(inst, rest);
    case 'status': return status(inst);
    case 'stop': return stop(inst);
    case 'reset': return reset(inst);
    case 'destroy': return destroy(inst);
    case 'rawlog': return rawlog(inst);
    case 'compose': return composePassthrough(inst, rest);
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return undefined;
    default:
      fail(`unknown command ${command}\n${USAGE}`);
  }
}

main().catch((err) => {
  if (err instanceof Failure) {
    console.error(`e2e: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
});

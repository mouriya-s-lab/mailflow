# Local end-to-end environment

A full MailFlow stack built from the current checkout, plus a Dovecot IMAP server, for
runtime acceptance on this machine through the real browser, the real API and real IMAP.
Several agents can run it at the same time: every command acts on one named **instance**,
and instances do not see each other.

It runs on the local OrbStack Docker engine and is not used in CI.

## Requirements

- Docker with Compose v2, Node 22 or newer on the host, `git`.
- The long-lived shared containers `shared-postgres` (PostgreSQL, host port 65432) and
  `shared-redis` (Redis with 64 logical databases, host port 56379). Both are registered,
  with their start definitions, in the OrbStack ledger `~/Ext/work/orbstack/README.md`.
  `up` starts them when they are stopped; no command here stops, recreates or reconfigures
  them.
- `~/.commandcode/auth.json` with an `apiKey`. `up` reads it and passes it to the backend as
  `JEV_API_KEY` through the environment of the one `docker compose up` it runs; no other
  command, `compose` passthrough included, has it in its environment. `e2e.mjs` never prints
  the key and writes it to no file of its own. Like any container environment variable, it
  is stored in the Docker engine's metadata for the backend container (on the engine's disk)
  for as long as that container exists, and anyone with access to the Docker engine can read
  it, for example with `docker inspect`; `stop` and `destroy` remove the container and with
  it that copy.

## Instances

Every command reads the instance name from `E2E_INSTANCE` (default `default`). Use your agent
name. Names are case-insensitive, 1–40 letters, digits or underscores.

| Resource | Per instance `<i>` |
|---|---|
| Compose project | `mailflow-e2e-<i>`: containers `mailflow-e2e-<i>-{frontend,backend,dovecot}-1`, network `mailflow-e2e-<i>_mailflow`, images `mailflow-e2e-<i>-{frontend,backend}` |
| Database | `mailflow_e2e_<i>` on `shared-postgres`, owned by a role of the same name that only this instance's backend uses |
| Slot `N` (1–63) | Recorded as the comment `mailflow-e2e slot=N` on that database. Allocated on first `up` (lowest free number), kept until `destroy` |
| Frontend | `http://localhost:<38700+N>` (bound to 127.0.0.1); `up` and `status` print it |
| Redis | logical database `N` of `shared-redis` |
| Dovecot | its own container; mail lives in tmpfs and disappears with the container |

The slot is allocated while holding a PostgreSQL advisory lock, so two instances started at
the same moment get different slots. The frontend and backend images are built from the
working tree with `BUILD_SHA` set to `git rev-parse HEAD`, so `/api/version` reports the
commit under test; `up` warns when the working tree has uncommitted changes, because those
are built in too.

Open the frontend as `http://localhost:<port>`, not `127.0.0.1`: the backend's `APP_URL` is
the `localhost` URL, and WebSocket connections from any other origin are refused. Browsers
keep cookies per host, not per port, so use a separate browser session (for example a
separate `agent-browser --session`) for each instance you are signed in to.

## Commands

Run from the repository root:

```bash
E2E_INSTANCE=<name> node fork-features/e2e/e2e.mjs <command>
```

| Command | Effect |
|---|---|
| `up` | Builds frontend and backend from the checkout, creates the instance database and slot if missing, starts or updates the stack (only changed services are rebuilt and recreated), then waits until `/api/health` is `ok` and `/api/version` reports HEAD through the frontend port, and prints `status`. Migrations run when the backend starts |
| `seed [options] [eml…]` | APPENDs `.eml` files into Dovecot and makes sure MailFlow has the account; see [Seeding](#seeding) |
| `status` | URL, database, Redis database, IMAP endpoints and containers |
| `stop` | Removes the instance's containers and network. The database, the slot and the Redis database are kept; Dovecot's mail is gone |
| `reset` | Drops and recreates the instance database (same slot) and flushes its Redis database. A running instance is restarted, which also gives it an empty Dovecot and re-applies the migrations |
| `destroy` | Removes containers, network and images, drops the database and its role, and flushes the Redis database. Run it when you are done |
| `rawlog` | Prints the Dovecot IMAP rawlogs; see [Logs](#logs) |
| `compose <sub> [args…]` | Read-only `docker compose` for this instance: `<sub>` is one of `ps`, `logs`, `top`, `config`, `images`, `port`, e.g. `compose logs -f backend`. It runs without `JEV_API_KEY`, so `config` shows that variable without a value; `config --environment` is refused. Every other subcommand is refused, because it would either create containers without the key (`up`, `create`, `run`) or could print a container's environment (`exec`): (re)create containers with `up`, remove them with `stop` or `destroy` |

Because Dovecot is not persistent, an instance that was stopped comes back with the same
MailFlow data but empty mailboxes; MailFlow then syncs the empty server. Seed again after
`up`.

## IMAP endpoints

Both endpoints are the same Dovecot (2.4, the `dovecot/dovecot` image) inside the instance
network, implicit TLS on port 31993 with a self-signed certificate. Any user name logs in
with the password `e2e-imap-password`; each user has its own mailboxes.

| Endpoint | Host | Post-login capabilities |
|---|---|---|
| full | `dovecot:31993` | include `MOVE`, `UIDPLUS`, `CONDSTORE`, `IMAP4rev2` |
| degraded | `dovecot-degraded:31993` | the same list without `MOVE`, `UIDPLUS` and `IMAP4rev2` |

Dovecot tells the two apart by the TLS SNI name (`local_name dovecot-degraded` in
`dovecot.conf`); MailFlow sends the account's host name as SNI. Things to know when testing
the degraded endpoint:

- Only the post-login `CAPABILITY` differs. Before LOGIN both endpoints advertise the same
  list, without `MOVE` or `UIDPLUS`.
- `imap_capability` changes what Dovecot advertises, not what it does: on the degraded
  endpoint it still returns `COPYUID` and `APPENDUID` response codes, and still executes a
  `MOVE` that a client sends without it being advertised.

Check the capabilities from inside the instance network:

```bash
dovecot=$(docker ps -q --filter label=com.docker.compose.project=mailflow-e2e-<i> --filter label=com.docker.compose.service=dovecot)
printf 'a CAPABILITY\r\nb LOGIN alice e2e-imap-password\r\nc CAPABILITY\r\nd LOGOUT\r\n' |
  docker exec -i "$dovecot" openssl s_client -quiet -connect dovecot-degraded:31993 -servername dovecot-degraded
```

Use `dovecot` for both host names to see the full endpoint.

## Seeding

```bash
E2E_INSTANCE=<name> node fork-features/e2e/e2e.mjs seed \
  [--mail-user alice] [--folder INBOX] [--endpoint full|degraded] \
  [--mf-user e2e] [--mf-password e2e-mailflow-password] [--timeout 120] \
  [file.eml | directory]…
```

1. Each fixture is APPENDed over IMAP to `<mail-user>`'s `<folder>` (created first when
   missing). A directory argument means every `*.eml` in it, in name order.
2. MailFlow: logs in as `<mf-user>`, registering it when it does not exist (the first user
   of an instance becomes its admin). As admin it turns on the settings "Allow private /
   local hosts" and "Allow insecure TLS", which a Dovecot on a private address with a
   self-signed certificate needs. It then adds the IMAP account for `<mail-user>` on the
   chosen endpoint through `POST /api/accounts`, or reuses it if that user already has one
   on that host.
3. It waits until every fixture that has a `Message-ID` is in MailFlow's `messages` table for
   that account and folder, and fails after `--timeout` seconds otherwise.

With no fixture arguments it only does steps 2 and 3. If you registered the MailFlow user in
the browser first, pass the same `--mf-user`/`--mf-password`.

**Fixture format.** A fixture is one RFC 5322 message, as it would arrive: any headers in any
order (`Authentication-Results`, `ARC-*`, `Received-SPF`, `List-Id`, raw 8-bit or
encoded-word values, folded lines), then a blank line and the body. Seed sends the bytes as
they are, except that line endings are normalised to CRLF. `Message-ID` is optional but is
how seed confirms the message reached MailFlow. Examples are in `fixtures/`.

## Logs

- Application: `compose logs backend`, `compose logs frontend`, `compose logs dovecot`.
  Dovecot logs every login and every saved, copied and expunged message with its
  Message-ID, e.g. `imap(alice)<57><…>: Info: Mailbox Target: copy from INBOX: uid=1, msgid=<…>`.
- Dovecot `mail_debug`: start the instance with `E2E_DOVECOT_MAIL_DEBUG=1`; the extra lines
  go to `compose logs dovecot`.
- IMAP rawlog: start the instance with `E2E_DOVECOT_RAWLOG=1`. Dovecot then writes one
  `<date>-<time>.<pid>.<n>.in` / `.out` pair per post-login IMAP session under
  `/var/log/rawlog` in the Dovecot container, and `rawlog` prints them all with a
  `==> <file> <==` header per file. The `<pid>` is the one in the log lines
  `imap(<user>)<pid>…`, which tells you whose session a file is.

Both switches are read when the Dovecot container is created. Pass them on the `up` that
first creates the container, or on a later `up` (changing them recreates Dovecot with empty
mailboxes, so seed again):

```bash
E2E_INSTANCE=<name> E2E_DOVECOT_RAWLOG=1 E2E_DOVECOT_MAIL_DEBUG=1 node fork-features/e2e/e2e.mjs up
```

## Reading state directly

```bash
docker exec shared-postgres psql -U postgres -d mailflow_e2e_<i>   # the instance database
docker exec shared-redis redis-cli -n <N>                         # its Redis database
```

`E2E_INSTANCE=<name> node fork-features/e2e/e2e.mjs status` prints `N`.

## Files

| Path | What |
|---|---|
| `e2e.mjs` | The commands above |
| `compose.yml` | Services of one instance; meant to be run through `e2e.mjs`, which supplies its `E2E_*` values |
| `dovecot.conf` | Added to the image's Dovecot config: certificate paths, the degraded endpoint, optional rawlog and `mail_debug` |
| `fixtures/*.eml` | Sample messages with `Authentication-Results` and other headers |

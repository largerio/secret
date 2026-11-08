# Self-hosting guide

You can deploy your own Secret instance in a few minutes, without cloning or
building anything. The official image is published at
[`ghcr.io/largerio/secret`](https://ghcr.io/largerio/secret) and runs as a
single container.

| Where you're deploying | Start here |
|---|---|
| A VPS, or any host with Docker | [Quick deploy](#quick-deploy-vps--any-docker-host), with HTTPS in one command |
| Coolify, Portainer, Render | [One-click & platform deploys](#one-click--platform-deploys) |
| A Synology NAS | [Synology NAS](#synology-nas-dsm-7--container-manager) |
| Behind a proxy you already run | [Reverse proxy & HTTPS](#reverse-proxy--https) |

Once it's running: [Configuration](#configuration) ·
[API keys](#api-keys-for-the-sdk) ·
[Secrets in files](#secrets-in-files) ·
[Restricting who can create notes](#restricting-who-can-create-notes) ·
[Backup & restore](#backup--restore) · [Storage cleanup](#storage-cleanup) ·
[One instance per database](#one-instance-per-database) ·
[Monitoring](#monitoring) · [Updating](#updating) ·
[Verifying the image](#verifying-the-image) ·
[Deploying from CI](#deploying-from-ci) · [Troubleshooting](#troubleshooting)

> **Image architecture:** the image is multi-arch (`linux/amd64` and
> `linux/arm64`), so it runs natively on x86 servers and on ARM hosts such as
> Synology ARM models, Raspberry Pi (64-bit) and Apple Silicon.

---

## Quick deploy (VPS / any Docker host)

All you need is `docker-compose.yml`. There's no repository to clone and no
key to create: the server's encryption key is generated on the first launch
and kept in the data volume.

```bash
mkdir secret && cd secret
curl -O https://raw.githubusercontent.com/largerio/secret/main/docker-compose.yml
docker compose up -d
```

The container pulls `ghcr.io/largerio/secret:1`, the latest 1.x release,
creates a Docker volume for your data, and serves the app on port `3000`.
Open `http://<your-host>:3000` and you're live.

Plain HTTP is fine for trying it out on a local network, but put HTTPS in
front before sharing real secrets. Over HTTP, the link, and with it the
decryption key, crosses the network in clear. Browsers also reserve some
features, such as one-click copy, for secure pages.

**On your own domain, with HTTPS.** `docker-compose.tls.yml` adds Caddy,
which gets and renews the certificate for you:

```bash
curl -O https://raw.githubusercontent.com/largerio/secret/main/docker-compose.tls.yml
echo "DOMAIN=secret.example.com" > .env

docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

Point the domain at this host first, since Caddy proves you own it over ports
80 and 443. Those are the only two ports published: the app itself can only
be reached through the proxy, and `APP_URL` is derived from `DOMAIN`.

Already running a reverse proxy? Skip that file, set `APP_URL` in `.env`, and
see [Reverse proxy & HTTPS](#reverse-proxy--https).

> ⚠️ **The encryption key can't be rotated.** Starting an instance with a
> different `SERVER_ENCRYPTION_KEY` would make every stored note permanently
> unreadable, so the server checks a fingerprint and refuses to start
> instead. To manage the key yourself, set it **before the very first
> launch**. Otherwise it lives in the data volume, at `.encryption_key`.
> Either way, back it up separately from the data
> ([Backup & restore](#backup--restore)). If you hit a mismatch, see
> [Container keeps restarting](#container-keeps-restarting--exits-immediately).

---

## One-click & platform deploys

### One-liner `docker run`

The quickest way to spin up a test instance, without any files:

```bash
# Generate and SAVE the key (without it, notes are unreadable forever)
KEY=$(openssl rand -base64 32); echo "SERVER_ENCRYPTION_KEY=$KEY"

docker run -d --name secret -p 3000:3000 \
  -v secret-data:/app/data \
  -e SERVER_ENCRYPTION_KEY="$KEY" \
  -e APP_URL=http://localhost:3000 \
  ghcr.io/largerio/secret:1
```

For a real deployment, set `APP_URL` to your public `https://` address, and
put a reverse proxy in front (see below).

### Coolify

Coolify provides HTTPS through its built-in proxy.

1. **New Resource** → **Docker Image** → `ghcr.io/largerio/secret:1`
   (or **Docker Compose**, and paste this repo's `docker-compose.yml`).
2. **Environment variables:** set `APP_URL` to the domain Coolify assigns.
3. **Persistent Storage:** add a volume mounted at **`/app/data`**. The
   encryption key is generated there on the first start.
4. **Ports:** expose `3000`. Coolify provisions the TLS certificate.

### Portainer

1. **Stacks** → **Add stack** → **Web editor**.
2. Paste this repo's `docker-compose.yml`.
3. Set `APP_URL` in the environment variables, then **Deploy the stack**.
   The encryption key is generated in the stack's volume on the first start.

### Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/largerio/secret)

The button deploys the [`render.yaml`](../render.yaml) blueprint, which runs
the image `ghcr.io/largerio/secret:1` on a persistent disk mounted at
`/app/data`. Render then asks for two values:

- `APP_URL`: the address Render gives the service
  (`https://<service>.onrender.com`), or your own domain.
- `SERVER_ENCRYPTION_KEY`: 32 random bytes in base64, from
  `openssl rand -base64 32`. Render's own "generate" button doesn't produce
  that format. Keep a copy: without it, the notes can't be read.

A persistent disk needs a paid instance type: on the free tier, every
redeploy would wipe the notes. Render injects `PORT` and routes traffic to
it, and the app serves both the site and the API on that port.

---

## Synology NAS (DSM 7 / Container Manager)

1. **Install Container Manager** from the DSM Package Center, if it isn't
   installed yet.
2. **Prepare a folder.** In File Station, create `docker/secret`, and put two
   files in it:
   - [`docker-compose.yml`](https://raw.githubusercontent.com/largerio/secret/main/docker-compose.yml)
   - `.env`, with `APP_URL` set to the address you'll use (e.g.
     `https://secret.example.com`). The encryption key is generated in the
     volume on the first start.
3. **Create the project.** Container Manager → **Project** → **Create** →
   set the path to `docker/secret` and import the existing `docker-compose.yml`.
4. **Run it.** Build/Start the project. Container Manager pulls
   `ghcr.io/largerio/secret:1` on its own.
5. **Open it.** Port `3000` is mapped on the NAS: browse to
   `http://<NAS-IP>:3000`.

### Synology notes & caveats

- The container runs as a **non-root user (uid 1001)** on a **read-only root
  filesystem**. Only the `secret-data` volume and an in-memory `/tmp` are
  writable. With the named Docker volume, this works out of the box on DSM,
  with no permission tweaks.
- **Prefer the named volume `secret-data`**, the default. If you bind-mount a
  NAS folder instead (e.g. `/volume1/docker/secret/data:/app/data`), give uid
  1001 write access to it first:
  ```bash
  sudo chown -R 1001:1001 /volume1/docker/secret/data
  ```
- To change the published port (if 3000 is taken, say), set `PORT=8080` in
  `.env`.

---

## Configuration

Everything is set through environment variables, in `.env` next to
`docker-compose.yml`. [`.env.example`](../.env.example) lists them all; these
are the ones you're most likely to need:

| Variable | Default | What it does |
|----------|---------|--------------|
| `SERVER_ENCRYPTION_KEY` | generated | The server's AES-256-GCM key, 32 bytes in base64. If unset, it's generated on the first start and kept in the data volume. Never change it once notes exist: see [the warning above](#quick-deploy-vps--any-docker-host) |
| `APP_URL` | `http://localhost:3000` | The public address, `http://` or `https://` |
| `APP_NAME` | `Secret` | The name shown in the pages |
| `APP_DESCRIPTION` | — | The home page's description for search engines and link previews, in every language. If unset, each language keeps its own |
| `APP_PRIMARY_COLOR` | indigo | The accent color, in hex (`#1d4ed8`). The gradients and the dark theme's shade follow it |
| `APP_FOOTER_TEXT`, `APP_OG_IMAGE_URL` | — | A footer text, and the image shown in link previews |
| `MAX_CHUNKED_FILE_SIZE` | `524288000` | The most file bytes a note can carry (500 MB). Its padding takes a little more room: at most 6.25%, and 0.8% at 500 MB |
| `MAX_FILES_PER_NOTE` | `10` | Files per note, 10 at most |
| `MAX_FILE_SIZE` | `10485760` | Sets the body limit of a note sent in one request: `MAX_FILE_SIZE × MAX_FILES_PER_NOTE`, plus 1 MB. Larger notes go up in chunks, so there's rarely a reason to change it |
| `CHUNK_SIZE` | `4194304` | The size of those chunks (4 MB). The web app follows it; SDK clients must pass the same value as `chunkSize` |
| `MAX_EXPIRY` | `2592000` | The longest a note can live, in seconds (30 days). It can only be lowered, to 300 at least |
| `STORAGE_QUOTA_BYTES` | `0` | The total room for encrypted notes, `0` for no limit. Past it, writes get `507` until notes expire or are deleted. Usage shows in the [metrics](#metrics) |
| `STORAGE_RECONCILE` | `true` | The daily sweep that deletes stored files no note points to. It needs a bucket or `FILES_PATH` used by this instance alone: see [Storage cleanup](#storage-cleanup) |
| `API_KEY`, `API_KEY_1`, `API_KEY_2`… | — | [API keys](#api-keys-for-the-sdk) for scripts, the SDK and the command line, 32 characters at least |
| `…_FILE` | — | Reads a secret from a file: see [Secrets in files](#secrets-in-files) |
| `ADDRESS_HEADER`, `XFF_DEPTH`, `TRUSTED_PROXIES` | — | Where the client's address comes from behind a reverse proxy: see [Making rate limiting work behind a proxy](#making-rate-limiting-work-behind-a-proxy) |
| `RATE_LIMIT_MULTIPLIER` | `1` | Scales every per-IP rate limit. Raise it when many people share one address (a company NAT, a VPN) |
| `CAP_DIFFICULTY`, `CAP_CHALLENGE_COUNT` | `4`, `50` | The proof of work a browser solves before each write. Raise them under sustained abuse |
| `METRICS_TOKEN` | — | Turns on `/api/metrics` for requests that carry it, 32 characters at least: see [Metrics](#metrics) |
| `ALLOW_SERVER_KEY_CHANGE` | `false` | Lets the server start with another `SERVER_ENCRYPTION_KEY`, giving up every existing note |
| `SHUTDOWN_TIMEOUT` | `8` | Seconds a stopping container gives the requests in flight. Keep it a couple of seconds under the stop grace period (10 s unless raised) |
| `PORT` | `3000` | The host port compose publishes. Platforms that inject it (Render, Railway, Cloud Run) get both the site and the API on it |

On/off settings (`ALLOW_SERVER_KEY_CHANGE`, `S3_FORCE_PATH_STYLE`,
`STORAGE_RECONCILE`, `DEBUG`) take `true` or `1` for on, and `false` or `0`
for off. Leaving one blank keeps the default. Any other value, like any
invalid setting, stops the server at startup.

After changing `.env`, run `docker compose up -d --force-recreate`.

### S3 storage

Files are kept in the data volume by default. To keep them in an
S3-compatible bucket instead:

```env
STORAGE_BACKEND=s3
S3_BUCKET=my-bucket
S3_REGION=us-east-1
S3_ENDPOINT=http://rustfs:9000   # leave out for AWS S3
S3_ACCESS_KEY_ID=your-key
S3_SECRET_ACCESS_KEY=your-secret
S3_FORCE_PATH_STYLE=true         # needed by self-hosted servers
```

This works with AWS S3, Cloudflare R2, and self-hosted servers such as
[RustFS](https://github.com/rustfs/rustfs) or
[Garage](https://garagehq.deuxfleurs.fr). With Garage, set `S3_REGION` to
its region (`garage` by default). The two keys can also come from files,
with `S3_ACCESS_KEY_ID_FILE` and `S3_SECRET_ACCESS_KEY_FILE`.

Give each instance a bucket of its own, without versioning, and add the
lifecycle rule from [S3 bucket settings](#s3-bucket-settings).

---

## Reverse proxy & HTTPS

This section is for a proxy you run yourself. If you don't have one,
`docker-compose.tls.yml` ([Quick deploy](#quick-deploy-vps--any-docker-host))
brings its own Caddy, and there's nothing to set up here.

**Caddy** gets the certificate and sets `X-Forwarded-For` on its own:

```caddyfile
secret.example.com {
    reverse_proxy localhost:3000
}
```

**Nginx:**

```nginx
server {
    listen 443 ssl;
    server_name secret.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 150M;
    }
}
```

Two things to check:

- The body limit must fit the largest single upload request,
  `MAX_FILE_SIZE × MAX_FILES_PER_NOTE + 1 MB` (about 101 MB by default). It
  doesn't need to fit `MAX_CHUNKED_FILE_SIZE`: large notes go up in 4 MB
  chunks, one request each.
- Set `APP_URL` in `.env` to your `https://` address.

### Making rate limiting work behind a proxy

Behind a reverse proxy, **every visitor shares the proxy's rate-limit
bucket** until you tell the app where to find the client's address. The
limits still apply, but to the whole instance at once, so one busy visitor
can use them up for everybody.

By default, the app treats whoever connects to it as the client. Behind a
reverse proxy, that's the proxy, and it's the same for every visitor. The app
can't guess that a proxy sits in front of it, or where the proxy puts the
client's address.

Two variables fix that:

```env
# Derive the client address from the header your proxy sets, and say how many
# proxies sit in front of the app (1 for a single Nginx/Traefik/Caddy/Cloudflare
# hop, 2 if Cloudflare fronts your own proxy, and so on).
ADDRESS_HEADER=X-Forwarded-For
XFF_DEPTH=1
```

If the instance is exposed directly, with no proxy in front, it already
tells clients apart and needs neither. It can't know there's no proxy,
though, so without either variable it logs
`WARNING: neither ADDRESS_HEADER nor TRUSTED_PROXIES is set` at every start.
You can ignore it.

When `ADDRESS_HEADER` is set, it alone decides the address, and
`TRUSTED_PROXIES` is ignored. Without it, `TRUSTED_PROXIES` lists the proxies
(addresses or CIDR ranges) whose `X-Forwarded-For` or `X-Real-IP` the app
trusts. It's empty by default, so the app trusts no one.

Get `XFF_DEPTH` right. `X-Forwarded-For` is a list a client can prefill, and
only the last entries, the ones your own proxies added, can be trusted. Set
it too high and a client can pick its own bucket; set it too low and
everyone shares one again.

Your proxy must actually set the header. Nginx needs it spelled out:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Real-IP $remote_addr;
```

Caddy and Traefik set it on their own.

**Check that it worked.** Recreate the container, then look for the warning
in the startup log:

```bash
docker compose up -d --force-recreate
docker compose logs app | grep 'neither ADDRESS_HEADER nor TRUSTED_PROXIES'
```

The command prints nothing once `ADDRESS_HEADER` or `TRUSTED_PROXIES` reaches
the app. An invalid `ADDRESS_HEADER` or `XFF_DEPTH` stops the start instead,
with an error that names it. Neither tells you whether `XFF_DEPTH` matches
your setup: you have to count your proxies yourself.

Requests that bypass the proxy, such as the container's own health check,
carry no such header, so they're counted under the address that sent them.

**On Synology**, you can use DSM's built-in reverse proxy instead of your
own: DSM → **Login Portal → Advanced → Reverse Proxy** → create a rule from
`secret.example.com:443` → `localhost:3000`. DSM manages the certificate.

---

## API keys (for the SDK)

Reading is open; writing isn't. A browser solves a proof-of-work challenge
before each write. Anything scripted, such as the
[JS SDK](https://www.npmjs.com/package/@largerio/secret-sdk) or a backup job,
is simpler with a key you issue in `.env`:

```env
API_KEY=<openssl rand -base64 32>   # 32 characters minimum
# API_KEY_1=…                       # one per client, to revoke them separately
```

Then run `docker compose up -d --force-recreate`. A key only authorizes
writes: it gives no read access beyond what anyone has, and no way to
decrypt anything.

The [command line](../packages/cli/README.md) reads the key from
`SECRET_API_KEY`, or from the file named by `SECRET_API_KEY_FILE`. Without a
key, it solves the proof of work like a browser does.

---

## Secrets in files

Any secret can be read from a file instead of a variable, which is how Docker
and Kubernetes hand secrets to a container. Append `_FILE` to the variable's
name, and give it the file's path.

| Variable | From a file |
|---|---|
| `SERVER_ENCRYPTION_KEY` | `SERVER_ENCRYPTION_KEY_FILE` |
| `API_KEY`, `API_KEY_1`… | `API_KEY_FILE`, `API_KEY_1_FILE`… |
| `S3_ACCESS_KEY_ID` | `S3_ACCESS_KEY_ID_FILE` |
| `S3_SECRET_ACCESS_KEY` | `S3_SECRET_ACCESS_KEY_FILE` |
| `METRICS_TOKEN` | `METRICS_TOKEN_FILE` |

The file holds just the value; trailing line breaks are ignored. The server
refuses to start if a variable is set along with its `_FILE`, or if the file
is missing, unreadable or empty. The error names the variable and the path,
never what the file holds.

With Compose, declare the secrets in a `docker-compose.override.yml` next to
`docker-compose.yml`:

```yaml
services:
  app:
    environment:
      - SERVER_ENCRYPTION_KEY_FILE=/run/secrets/server_key
      - API_KEY_FILE=/run/secrets/api_key
    secrets:
      - server_key
      - api_key

secrets:
  server_key:
    file: ./secrets/server_key
  api_key:
    file: ./secrets/api_key
```

```bash
mkdir secrets
openssl rand -base64 32 > secrets/server_key
openssl rand -base64 32 > secrets/api_key
chmod 400 secrets/*
# Compose mounts each file as it is on the host: the container's user must read it
sudo chown 1001:1001 secrets/*
```

`docker compose up -d` picks up the override on its own. A command that
lists its files with `-f`, like the HTTPS setup, must list it too:
`-f docker-compose.override.yml`.

**What this protects.** A value in `.env` or under `environment:` shows up
in `docker inspect`, and in the environment of the process inside the
container. A secret file keeps it out of both: only its path shows. It isn't
isolation, though: code running in the app could still read the files, just
as it can read the data volume. The container runs a single process, the
API, which reads them; the web app's code only runs in browsers.

**The server key.** Without `SERVER_ENCRYPTION_KEY` or
`SERVER_ENCRYPTION_KEY_FILE`, the image generates the key on the first start,
keeps it in the data volume at `/app/data/.encryption_key`, and passes it to
the API as `SERVER_ENCRYPTION_KEY_FILE`. (`KEY_FILE` changes where that
generated file goes, and is ignored once you provide a key either way.) Kept
in a secret instead, the key no longer travels with the volume and its
backups, so the server's encryption layer also protects a stolen copy of the
volume. To move a generated key out of the volume:

```bash
mkdir -p secrets
docker compose exec -T app cat /app/data/.encryption_key > secrets/server_key
chmod 400 secrets/server_key && sudo chown 1001:1001 secrets/server_key
# With the override above in place:
docker compose up -d
# Once the instance is up and serves its notes:
docker compose exec app rm /app/data/.encryption_key
```

If the file holds the wrong key, the server refuses to start, since it
doesn't match the notes. Backups made before the move still contain the key.

Outside the image, the API reads the same variables. On Kubernetes, mount
the Secret as a volume, and point the `_FILE` variables at its files.

---

## Restricting who can create notes

Out of the box, anyone who can reach the instance can create notes, with
files up to `MAX_CHUNKED_FILE_SIZE` (500 MB by default). The only things in
the way are the proof-of-work challenge a browser solves before each write,
the per-IP rate limits, and the storage quota (`STORAGE_QUOTA_BYTES`) if you
set one. To keep an instance for your own people, put a login in front of
the paths that create notes, and only those: the people you send links to
don't have an account.

Creating or deleting a note requires a proof-of-work token or an
[API key](#api-keys-for-the-sdk), and a browser gets its token from
`/api/cap/`. The chunks of a large upload carry neither, but they can only
extend an upload that was started with one. So behind a login, `/api/cap/`
alone is enough to stop anyone without an account from writing. Putting `/`
behind it too spares them a form they could fill in but never send.

| Behind the login | |
|---|---|
| `/api/cap/` and below | The proof-of-work challenge: without its token, no browser can create or delete a note |
| `/` | The page that creates notes, when a browser loads it |

The web app switches between its pages in the browser, so a visitor who
follows a link from a note's page to the page that creates notes gets the
form without any request the login could catch. `/api/cap/` is what stops
them, when they try to send it.

| Left open | |
|---|---|
| `/note/` and below | The page a recipient opens, and the page behind a note's delete link. A login redirect would also drop the part of the link after `#`, which holds the key, or carry it over to the login pages |
| `/api/v1/` and below | Reading notes, the checks a note's page makes, `/api/v1/config` and the API docs. The writes there check their own token or key |
| `/_app/`, `/wasm/`, `/favicon.svg`, `/og.png` | Scripts, styles and fonts, the challenge solver, the icon, and the image shown in link previews |
| `/bundle.json` | The list of the web app's files and their digests, to [check what the instance serves](../SECURITY.md#verifying-the-web-app) |
| `/api/health`, `/robots.txt`, `/sitemap.xml` | Health checks and crawlers |

Deleting a note from its delete link also solves a challenge, so it works in
a logged-in browser. Reading a note never does. Scripts and the SDK bypass
the login: they write with an [API key](#api-keys-for-the-sdk), which the API
checks itself, on paths that stay open. The command line does too when it
has a key. Without one, it asks `/api/cap/` for a challenge, and the login
stops it there.

Two things keep people from getting around the login:

- The app must only be reachable through the proxy. A published port `3000`
  is a way in that bypasses it (`docker-compose.tls.yml` only publishes
  Caddy's ports).
- The proxy must match the path after normalizing it, since the app reads
  `/api/v1/../cap/challenge` as `/api/cap/challenge`. Caddy and Traefik do,
  with the rules below.

The proxy that asks for the login is a reverse proxy like any other, so set
`ADDRESS_HEADER` and `XFF_DEPTH` as described in
[Making rate limiting work behind a proxy](#making-rate-limiting-work-behind-a-proxy).

**Caddy with oauth2-proxy.** This is adapted from oauth2-proxy's Caddy
integration. It assumes oauth2-proxy is set up for your identity provider,
with its `--reverse-proxy` flag on, and
`https://secret.example.com/oauth2/callback` as its redirect URL:

```caddyfile
secret.example.com {
	# oauth2-proxy's own pages: sign-in and callback.
	handle /oauth2/* {
		reverse_proxy oauth2-proxy:4180 {
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-Uri {uri}
		}
	}

	# The paths that create notes: log in first.
	@create path / /api/cap/*
	handle @create {
		forward_auth oauth2-proxy:4180 {
			uri /oauth2/auth
			header_up X-Real-IP {remote_host}

			@unauthenticated status 401
			handle_response @unauthenticated {
				redir * /oauth2/sign_in?rd={scheme}://{host}{uri}
			}
		}
		reverse_proxy app:3000
	}

	# Everything else stays open.
	handle {
		reverse_proxy app:3000
	}
}
```

**Traefik.** Put the same two paths on a router of their own, carrying your
`forwardAuth` middleware (oauth2-proxy's Traefik guide has one), next to the
router you already have, with the same entry points and TLS settings. Its
rule is the longer one, so Traefik tries it first:

```yaml
labels:
  - traefik.http.routers.secret.rule=Host(`secret.example.com`)
  - traefik.http.routers.secret-create.rule=Host(`secret.example.com`) && (Path(`/`) || PathPrefix(`/api/cap/`))
  - traefik.http.routers.secret-create.middlewares=oauth2-proxy-auth  # your forwardAuth middleware
```

---

## Backup & restore

An instance is made of three things, each backed up separately:

| What | Where | Lost without a backup |
|---|---|---|
| The database | `secret.db` in the volume (`DATABASE_PATH`) | Every note |
| The stored files | `files/` in the volume (`FILES_PATH`), or the S3 bucket | Every note with files |
| The server key | `SERVER_ENCRYPTION_KEY`, or the generated `.encryption_key` in the volume (`KEY_FILE`) | Everything: each note is sealed with it, and the server refuses to start with another one |

The key never changes, so you back it up once, and keep it apart from the
data, in a password manager or a secret store. A backup that holds both the
data and the key is only protected by the end-to-end encryption.

Compose prefixes the volume's name with the project's name (the folder you
ran `docker compose` from), so the real name is usually `secret_secret-data`.
Check the exact name first:

```bash
docker volume ls --format '{{.Name}}' | grep secret-data
```

Use that name wherever `<volume>` appears below.

### Back up

Back up the database first, then the files. A file stored in between has no
note in that copy of the database, so the
[storage sweep](#storage-cleanup) removes it after a restore. And a note
whose file was deleted in between had been read to its limit, deleted, or
had expired: it was meant to go anyway. In the opposite order, the notes
created in between would come back without their files.

**The database**, while the app is running:

```bash
docker compose exec app node apps/api/dist/backup.js /app/data/backup.db
docker compose cp app:/app/data/backup.db ./secret-$(date +%F).db
docker compose exec app rm /app/data/backup.db
```

The command copies the database at `DATABASE_PATH` with SQLite's
`VACUUM INTO`. That gives one consistent snapshot, taken without blocking the
app, with no trace of the notes already deleted. The command checks the
copy, writes it under a temporary name, and renames it into place. It never
overwrites an existing file, and it exits with a non-zero code if anything
fails, so a scheduled job notices.

The container's root filesystem is read-only, so the copy is written to the
volume first, then moved out. Only its owner can read it (mode `600`), since
it holds every note's deletion token. `docker compose cp` keeps that mode,
and gives the file to the user who runs it.

A signal (Ctrl-C, a closed terminal, a job's timeout) doesn't cut the copy
short: the command either finishes it, or fails and removes it, before
exiting. It exits with `0` only when the destination holds a complete,
checked copy. If the command is killed outright, by `SIGKILL` (a hard
timeout, the OOM killer) or along with the container if it stops or is
recreated during the backup, it can leave a `<destination>.<hex>.partial`
file and its `-journal` next to the destination. Delete them: like any
backup, they hold the notes.

The copy is a single SQLite file. It keeps the schema version, the instance
identity the sweep relies on, and the server key's fingerprint, so it
restores as is, on the version of Secret that made it or on a later one,
which migrates it at startup. Outside Docker, from a build of the
repository: `DATABASE_PATH=/path/to/secret.db node apps/api/dist/backup.js <destination>`.

**The files**, right after. On local storage:

```bash
docker run --rm -v <volume>:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/secret-files-$(date +%F).tgz -C /data files
```

On S3, copy the `notes/` prefix with your provider's tools (`aws s3 sync`,
`rclone`).

### Keeping backups

A backup holds every note as it was. A note burned by its last read since
then, or deleted with its deletion link, is still in it, and restoring the
backup brings the note back for anyone who still has the link. So:

- **Keep backups no longer than `MAX_EXPIRY`** (30 days by default), and
  less when you can: a week of daily copies covers most needs. Every note in
  an older backup has expired, so restoring it brings nothing back; it only
  holds ciphertexts and metadata.
- **No versioning and no long-lived snapshots.** A versioned bucket keeps
  every deleted file: see [S3 bucket settings](#s3-bucket-settings).
  Snapshots of the volume (ZFS, Btrfs, a VM, Synology Snapshot Replication)
  are backups too, and need the same limit.
- **Encrypt them** before they leave the host (`age`, `gpg`, or a backup
  tool that encrypts, such as restic or borg), with a key of their own,
  stored separately from the server key.

### Restore

1. Stop the app with `docker compose stop`. On a new host, run
   `docker compose up -d` first, so that compose creates the volume.
2. Put the database back, and delete the `-wal` and `-shm` files next to it:
   if they stay, SQLite replays the old log onto the restored database. Only
   the copy's owner can read it (mode `600`), hence the `chown` to the app's
   user.

   ```bash
   docker run --rm -v <volume>:/data -v "$PWD":/backup alpine sh -c '
     rm -f /data/secret.db-wal /data/secret.db-shm &&
     cp /backup/secret-<date>.db /data/secret.db &&
     chown 1001:1001 /data/secret.db'
   ```

3. If the files are lost too, restore the copy taken right after that
   database (a later one also works). On local storage:

   ```bash
   docker run --rm -v <volume>:/data -v "$PWD":/backup alpine \
     tar xzf /backup/secret-files-<date>.tgz -C /data
   ```

   On S3, copy `notes/` back into the bucket. Files the database doesn't know
   about can stay: the sweep removes them.
4. Bring the key back: set `SERVER_ENCRYPTION_KEY` in `.env`, or write the
   saved key over `.encryption_key` in the volume (owned by uid 1001, mode
   `600`). A new volume holds a key generated on its first start, which isn't
   the one you need.
5. Run `docker compose start` and watch `docker compose logs -f`. With the
   wrong key, the server refuses to start, with an explicit error.

An archive of the whole volume, made with the app stopped, restores in one
step: empty the volume (`rm -rf ./* ./.[!.]*`, so that no generated key is
left behind), then extract the archive into it.

### After a restore

- Notes created after the backup are gone: their links find nothing, and the
  sweep removes their files.
- Notes read to their limit or deleted since the backup are back, with their
  read count as it was, and anyone who still has the link can read them
  until they expire. Nothing records which ones, since a deletion leaves no
  trace.
- Notes that have expired since stay gone: the cleanup job deletes them, and
  an expired note is never served.

On an instance used for one-time secrets, tell your users that a link opened
before the backup date may open again, and that its deletion link still
removes it.

### What a stolen backup reveals

Not the contents. Notes are encrypted in the browser, and the key is in the
link's fragment, which never reaches the server. The payloads, in the
database and in the files, are also sealed with the server key: without that
key, they're opaque even before the end-to-end layer comes into play.

A backup does hold, in clear:

- the metadata listed in [What the server can see](../SECURITY.md#what-the-server-can-see):
  sizes, number of files, whether there's a password, read limits and reads
  so far, creation and expiry times;
- the note ids, the half of each link that decrypts nothing;
- each note's deletion token, so whoever holds the backup can delete those
  notes while they last.

---

## Storage cleanup

A note's files are deleted from storage as soon as the note goes, whether it
was read to its limit, deleted with its token, or expired. Each deletion is
recorded in the database first, so a storage outage or a restart halfway
through can't lose it: the cleanup job retries it, with backoff, for a
little over a day.

Anything that still slips through is removed by a daily sweep: any stored
file older than a day that no note, upload or pending deletion points to.
The first sweep runs ten minutes after startup, and logs a line whenever it
removes something.

During its first day on a storage, a database's sweep deletes nothing.
Instead, it logs how many stored notes it doesn't know about
(`storage sweep on trial`). A large count on an instance that just started
means it's running on the wrong database, such as a new volume after a
compose project was renamed. Stop it before the day is over.

### One storage location per instance

The sweep trusts the database to know every note, so the bucket (or
`FILES_PATH`) must belong to a single instance. To enforce this, each
database records its claim in the storage at startup, whether it sweeps or
not (`instances/<id>` in the bucket, `FILES_PATH/.instances/<id>` on disk).
When the sweep finds another database's claim, it deletes nothing and logs a
warning instead:

```
storage sweep skipped: another database has claimed this storage
```

This happens when two instances share a bucket. It also happens when an
instance starts on an empty database while the storage still holds the notes
of a database that claimed it: after a lost volume, a renamed compose
project, or a restore of a database backup older than the first claim. Point
each instance at its own bucket, or restore the right database and delete
the claim the wrong one left. If the other database is gone for good, delete
its claim, and the next sweep resumes.

A copy of a database carries its claim. An instance restored from another's
volume (a staging copy of production, say) can't be told apart from the
original, and needs a bucket of its own.

To turn the sweep off, set `STORAGE_RECONCILE=false`. Deletions are still
retried; only the files they miss stay behind.

### S3 bucket settings

- **Versioning off.** On a versioned bucket, a deletion only hides the
  object, and the ciphertext of every note stays in its earlier versions. If
  versioning has to stay on, expire noncurrent versions after a day.
- **No object lock or retention rule**: notes must be deletable at any time.
- **Permissions.** The key needs to read, write, delete and list objects
  under `notes/`, and to write and list them under `instances/`.
- **A lifecycle rule**, as a safety net. Incomplete multipart uploads, left
  behind when the server stops in the middle of a large file, are invisible
  to the sweep, so abort them after a day. And since no note outlives the
  30-day retention ceiling, anything under `notes/` older than 31 days is
  garbage. Limit the rule to that prefix: `instances/` holds the claims.

With the AWS CLI (other S3 servers, such as Cloudflare R2, Scaleway or
Garage, accept the same two actions; check your provider's documentation):

```bash
aws s3api put-bucket-lifecycle-configuration --bucket <bucket> \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "abort-incomplete-uploads",
        "Status": "Enabled",
        "Filter": {},
        "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
      },
      {
        "ID": "expire-notes",
        "Status": "Enabled",
        "Filter": { "Prefix": "notes/" },
        "Expiration": { "Days": 31 }
      }
    ]
  }'
```

Add `--endpoint-url` for a server other than AWS. If you lower `MAX_EXPIRY`,
you can lower the expiration to match: one day more than the ceiling.

---

## One instance per database

Run one container per database, and only one. The API keeps state in its own
process, so it doesn't scale out, and replicas behind a load balancer fail in
ways that look random:

- **Proof-of-work challenges live in memory.** The challenge, its solution
  and the write that spends the token must all reach the same process. When
  one of them lands on another replica, the note is refused.
- **Rate limits are counted per process**, so each replica adds its own
  allowance.
- **The chunks being written are tracked in memory.** Completing an upload
  waits for its last chunk to be stored. A completion that reaches another
  replica while a chunk is still being written there isn't refused, and the
  note can end up with a chunk nothing checked.
- **SQLite allows one writer at a time.** A second process on the same
  database file waits for the lock, or fails with `database is locked`. And
  the locking SQLite relies on doesn't work over a network filesystem (NFS,
  SMB), so keep the data volume on a local disk.
- **The background jobs run in every process**: the cleanup of expired
  notes, every five minutes by default, and the daily
  [storage sweep](#storage-cleanup).
- **Migrations run at startup.** A new version upgrades the database as it
  boots, and an older process still running on it during a rolling update
  then works against a schema it doesn't know. Stop the old container before
  starting the new one, as `docker compose up -d` does. On Kubernetes,
  that's the `Recreate` strategy, not `RollingUpdate`.

Two instances with their own databases can't share a bucket or a
`FILES_PATH` either. Each database only knows its own notes, so a link
created on one isn't found on the other, and each storage sweep finds the
other's claim and stops: see
[One storage location per instance](#one-storage-location-per-instance).

High availability, then, means bringing the one instance back quickly, not
running two:

- The container stops as soon as the app inside it exits, so its restart
  policy (`restart: unless-stopped` in `docker-compose.yml`) brings it back
  within seconds.
- Docker alone doesn't restart a container that's only `unhealthy`. An
  orchestrator can, based on the [health probes](#health-probes): a
  Kubernetes liveness probe, a Swarm service.
- If the host fails, start the instance elsewhere on the same data: a volume
  that can move with it, or the latest [backup](#backup--restore). On
  Kubernetes: one replica and a `ReadWriteOnce` volume.

---

## Monitoring

### Health probes

Three endpoints answer on the app's port, without a token:

| Path | `200` when | For |
|---|---|---|
| `/api/health/live` | The app's process answers. Nothing else is checked | A liveness probe, the image's `HEALTHCHECK` |
| `/api/health/ready` | The database and the storage answer, and the container isn't stopping. `503` otherwise | A readiness probe, an uptime monitor, a deploy |
| `/api/health` | Same as `/api/health/ready`, plus the version, the web app's digest and the quota | Checking by hand, and the checks that already call it |

```bash
curl http://localhost:3000/api/health
# {"status":"ok","checks":{"database":"ok","storage":"ok"},"storage":{"quotaBytes":null},"version":"1.8.0","revision":"<commit>","bundle":"sha256:<digest>"}
```

`status` is `ok`, `degraded` when a check fails (`database` is the volume,
`storage` is `FILES_PATH` or the S3 bucket), or `draining` once the
container is stopping. The checks are cached for 10 seconds, so polling
can't overload the storage.

The image's `HEALTHCHECK` polls liveness, not readiness. Docker keeps a
single health status, and proxies that route by it, such as Traefik reading
Docker labels, stop sending traffic to a container that isn't healthy. If
the health check polled readiness, a slow or unreachable storage would take
the whole site down, text notes included, which don't need storage.
Restarting the container wouldn't fix an S3 outage either. Readiness is for
whatever must notice an outage without cutting traffic: an uptime monitor,
so you hear about it, and a deploy, which shouldn't accept a container that
starts but can't reach its storage, as [Deploying from CI](#deploying-from-ci)
does.

**Stopping.** On `SIGTERM`, the container stops accepting connections right
away, and a health check still arriving on an open connection gets
`draining`. There's no window where it keeps taking new requests while
reporting `draining`, since with
[one instance per database](#one-instance-per-database) there's no other
instance to send them to. Requests in flight get `SHUTDOWN_TIMEOUT` seconds,
8 by default, before they're cut and the database is closed. Unless told
otherwise, Docker kills a container 10 seconds after asking it to stop. To
give long uploads more time, raise both, keeping the timeout a couple of
seconds under the grace period:

```yaml
services:
  app:
    environment:
      - SHUTDOWN_TIMEOUT=25
    stop_grace_period: 30s
```

### Version

`/api/health` reports the version and the commit the image was built from
(`revision`). The API reference (`/api/v1/openapi.json`) reports the version
too.

- A release reports its number, such as `1.8.0`.
- An image built from `main` after a release, such as `:main`, reports that
  release with a `-dev` suffix (`1.8.0-dev`), along with its own revision,
  since it holds changes the release doesn't.
- An image you build yourself reports the latest version in its
  `CHANGELOG.md`, whichever commit you built, and an `unknown` revision. To
  record the commit, pass it:
  `docker build --build-arg REVISION=$(git rev-parse HEAD) .`

`bundle` is the digest of the web app the instance serves, computed from its
files when the app starts. Each release publishes its own, and building the
same commit gives the same digest again: see
[Verifying the web app](../SECURITY.md#verifying-the-web-app). It's `null`
when the API runs without the web app.

### Metrics

`GET /api/metrics` exposes counters and gauges in the Prometheus text
format. It's off by default: the path answers `404` until `METRICS_TOKEN` is
set, and after that, `401` to any request without the token.

```env
METRICS_TOKEN=<openssl rand -base64 32>   # 32 characters minimum
```

The endpoint is served on the app's port, like the rest of the API, so the
token is what keeps it private. Your reverse proxy can also block
`/api/metrics` from outside your network. Prometheus sends the token as a
bearer token:

```yaml
scrape_configs:
  - job_name: secret
    scheme: https
    metrics_path: /api/metrics
    authorization:
      credentials_file: /etc/prometheus/secret-metrics-token
    static_configs:
      - targets: ["secret.example.com"]
```

Successful scrapes stay out of the logs; refused ones are logged.

| Metric | Type | Labels | |
|---|---|---|---|
| `secret_build_info` | gauge | `version`, `revision` | Always 1 |
| `secret_process_start_time_seconds` | gauge | | Uptime is `time() - secret_process_start_time_seconds` |
| `secret_process_resident_memory_bytes` | gauge | | |
| `secret_process_heap_used_bytes` | gauge | | |
| `secret_http_requests_total` | counter | `method`, `route`, `status` | `route` is the pattern (`/api/v1/notes/:id`), `status` the class (`2xx`) |
| `secret_http_request_duration_seconds` | histogram | `method`, `route` | Up to the response headers |
| `secret_notes_created_total` | counter | `type` | `text`, `file`, or `chunked` (a large upload) |
| `secret_note_reads_total` | counter | `type` | |
| `secret_notes_burned_total` | counter | | Deleted by the read that reached their limit |
| `secret_notes_deleted_total` | counter | | Deleted with their delete token |
| `secret_notes_expired_total` | counter | | Deleted once expired, by the cleanup job or by a read that found one |
| `secret_notes` | gauge | `type` | Notes in the database |
| `secret_upload_sessions` | gauge | | Chunked uploads in progress |
| `secret_storage_used_bytes` | gauge | | What `STORAGE_QUOTA_BYTES` counts |
| `secret_storage_quota_bytes` | gauge | | Only when a quota is set |
| `secret_storage_purges_total` | counter | `result` | Deletions of a note's files: `ok` or `error` |
| `secret_pending_deletions` | gauge | `state` | Deletions owed: `queued`, or `retrying` after a failed retry |
| `secret_pending_deletions_abandoned_total` | counter | | Deletions given up after their last retry |
| `secret_storage_sweep_last_run_timestamp_seconds` | gauge | | When the [storage sweep](#storage-cleanup) last ended |
| `secret_storage_sweep_last_status` | gauge | `status` | 1 for how it ended: `done`, `trial`, `skipped` or `failed` |
| `secret_storage_sweep_last_orphans` | gauge | | Files no note points to, found by the last sweep that ran |

Counters start again from zero when the container restarts. Worth an alert:

- readiness failing;
- `secret_pending_deletions{state="retrying"}` above zero for hours, or
  `secret_pending_deletions_abandoned_total` rising: deletions are failing,
  and the logs say why (often the storage credentials);
- a sweep `skipped` (see
  [One storage location per instance](#one-storage-location-per-instance));
- `secret_storage_used_bytes` close to the quota.

**What they reveal.** No metric carries a note id, an address or a path, and
none helps decrypt anything. They're still metadata about how the instance
is used: how many notes are created and read, of which kind, when, and how
much is stored. That's why they're off by default, and why the token
deserves the same care as an API key.

---

## Updating

```bash
docker compose pull     # fetch the latest image
docker compose up -d    # recreate the container
docker image prune -f   # clean up old layers
```

Your data lives in the volume, so updates never delete notes. Read the
**Upgrade notes** in [CHANGELOG.md](../CHANGELOG.md) before upgrading.

### Pinning a version

`docker-compose.yml` tracks `:1`, the latest 1.x release. To pin another
tag, change the `image:` line:

| Image tag | Tracks |
|-----------|--------|
| `ghcr.io/largerio/secret:1` | The latest 1.x release, **recommended** (the default): fixes and features, without breaking changes |
| `ghcr.io/largerio/secret:1.8` | The latest 1.8.x patch only |
| `ghcr.io/largerio/secret:1.8.0` | That exact release. It never moves, so it's fully reproducible |
| `ghcr.io/largerio/secret:latest` | The newest release of any major version: it moves to 2.x, and its breaking changes, when that ships |
| `ghcr.io/largerio/secret:main` | The tip of `main`, unreleased changes included: for testing only |

Between releases, `:1`, `:1.8` and `:latest` are rebuilt within a week of
each update of the base image (`node:26-alpine`), after a vulnerability scan
and a smoke test. An exact tag never changes, so it doesn't get those fixes.

---

## Verifying the image

Every image this repository publishes is signed by the GitHub Actions
workflow that built it, once the image has passed the vulnerability scan and
the smoke test, on `linux/amd64` and `linux/arm64` alike. It also carries a
[SLSA](https://slsa.dev) build provenance attestation, which records the
workflow, commit and run that produced it. Both are keyless
[Sigstore](https://www.sigstore.dev) signatures: there's no public key to
fetch, the signing certificate names the workflow, and each signature is
recorded in the public Rekor transparency log.

Verify a digest, then deploy that same digest, since a tag can move between
two commands:

```bash
IMAGE=ghcr.io/largerio/secret
DIGEST=$(docker buildx imagetools inspect "$IMAGE:1" --format '{{.Manifest.Digest}}')
SIGNER='^https://github\.com/largerio/secret/\.github/workflows/(deploy|rebuild-release)\.yml@refs/heads/main$'

# The signature, with cosign 3
cosign verify "$IMAGE@$DIGEST" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp "$SIGNER"

# The build provenance, with the GitHub CLI (logged in)
gh attestation verify "oci://$IMAGE@$DIGEST" --repo largerio/secret \
  --cert-identity-regex "$SIGNER"
```

Then deploy `ghcr.io/largerio/secret@sha256:…`, the digest you verified,
either on the `image:` line of `docker-compose.yml` or as `SECRET_IMAGE`
(see [Deploying from CI](#deploying-from-ci)).

**What the identity pins.** Two workflows build images, both from `main`.
`deploy.yml` builds `main`, and so every release. `rebuild-release.yml`
rebuilds the latest release on a newer base image each week. A rebuild's
provenance names that workflow and the `main` commit it ran from; the
release it rebuilt is in the image's `org.opencontainers.image.revision`
label.

**The SBOM is covered too.** The signature covers the image index, which
lists the SBOM and BuildKit's own provenance by digest:

```bash
docker buildx imagetools inspect ghcr.io/largerio/secret:1 --format '{{json .SBOM}}'
```

On Kubernetes, an admission policy (Kyverno, Sigstore policy-controller) can
require the same issuer and identity before a pod starts.

**The web app.** The signature covers the web app the image serves, along
with everything else. Your visitors can't check your image, but they can
check the web app itself: see
[Verifying the web app](../SECURITY.md#verifying-the-web-app).

---

## Deploying from CI

This repository's GitHub Actions workflow builds the image, scans it,
smoke-tests it and signs it, then deploys it over SSH. Two details are worth
copying into your own pipeline.

**Deploy the digest, not the tag.** `:1` and `:main` move. Between the scan
and the rollout, or between two rollouts, the tag can point somewhere else,
and once it has moved, there's nothing left to roll back to. The workflow
passes the digest it just built and scanned:

```bash
SECRET_IMAGE="ghcr.io/largerio/secret@sha256:..." docker compose up -d
```

Your compose file needs to accept it, with a default so that manual runs
still work:

```yaml
image: ${SECRET_IMAGE:-ghcr.io/largerio/secret:1}
```

**Wait until it's healthy and ready, and roll back if it never is.** A
container that starts and then fails every request still counts as a
successful `docker compose up`: the exit code says nothing about whether the
app works. The workflow polls the health status, then `/api/health/ready`
inside the container, since the health status only says the process
answers. If either never comes, it prints the last 50 lines of logs and
restores the image that was running before.

That's also why the workflow scopes its `docker image prune -f`: an
unfiltered prune deletes the previous image, which is the one a rollback
needs.

A complete reference file is in
[`docs/examples/docker-compose.prod.yml`](examples/docker-compose.prod.yml).

---

## Troubleshooting

Start with the logs: every startup error is printed there.

```bash
docker compose logs -f        # or: docker logs -f secret
```

### Container keeps restarting / exits immediately

If `SERVER_ENCRYPTION_KEY` isn't set, the container generates a key on the
first launch and stores it at `.encryption_key` in the data volume, so this
shouldn't happen on a fresh deployment.

If you **did** set the key and it's malformed, the logs show:

```
ERROR: SERVER_ENCRYPTION_KEY must be 32 bytes (256 bits) encoded in base64.
Generate one with: openssl rand -base64 32
```

If the key is valid but isn't the one that encrypted the existing notes:

```
ERROR: SERVER_ENCRYPTION_KEY does not match the key this database was created with.
```

Restore the original key: `docker compose exec app cat /app/data/.encryption_key`
prints the generated one. Only if the stored notes can be thrown away, start
once with `ALLOW_SERVER_KEY_CHANGE=true` to adopt the new key and give them
up.

Then either unset `SERVER_ENCRYPTION_KEY` to fall back to the generated key,
or set a valid one in `.env`, and run `docker compose up -d --force-recreate`.

> A key you set must be exactly **32 bytes encoded in base64** (44
> characters ending in `=`). A random password or a hex string is rejected.
> The data volume must also be writable by uid 1001, so that the generated
> key can be saved (for bind mounts: `chown -R 1001:1001 /path/to/data`).

### Changed `.env` but nothing happens

`docker compose up -d` only recreates the container when its configuration
changed. After editing `.env`, force it:

```bash
docker compose up -d --force-recreate
```

### Port 3000 already in use

Set another host port in `.env` (e.g. `PORT=8080`), then run
`docker compose up -d --force-recreate`. The app is then on
`http://<host>:8080`.

### "Permission denied" on `/app/data` (bind mounts)

This happens when you replace the named volume with a bind-mounted folder.
The container runs as **uid 1001**, so the folder must be writable by that
user:

```bash
sudo chown -R 1001:1001 /path/to/your/data
```

### Container is `unhealthy`

Look for the underlying error in `docker compose logs`, and query the health
endpoint from the host:

```bash
curl http://localhost:3000/api/health
# {"status":"ok","checks":{"database":"ok","storage":"ok"},…}
```

A failing check answers `503` and names the subsystem: `database` (the
volume) or `storage` (`FILES_PATH`, or the S3 credentials). The error itself
is in the logs, as `database probe failed` or `storage probe failed`. See
[Health probes](#health-probes).

### Uploads fail behind a reverse proxy

Raise the proxy's request body limit (`client_max_body_size` in Nginx) to at
least `MAX_FILE_SIZE × MAX_FILES_PER_NOTE + 1 MB` (about 101 MB by default):
see [Reverse proxy & HTTPS](#reverse-proxy--https).

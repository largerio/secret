# Self-Hosting Guide

Deploy your own Secret instance in minutes — no clone, no build. The official
image is published to [`ghcr.io/largerio/secret`](https://ghcr.io/largerio/secret)
and runs as a single container.

| Where you're deploying | Start here |
|---|---|
| A VPS, or any host with Docker | [Quick deploy](#quick-deploy-vps--any-docker-host) — with HTTPS in one command |
| Coolify, Portainer, Render | [One-click & platform deploys](#one-click--platform-deploys) |
| A Synology NAS | [Synology NAS](#synology-nas-dsm-7--container-manager) |
| Behind a proxy you already run | [Reverse proxy & HTTPS](#reverse-proxy--https) |

Once it is up: [API keys](#api-keys-for-the-sdk) ·
[Backup & restore](#backup--restore) · [Updating](#updating) ·
[Deploying from CI](#deploying-from-ci) · [Troubleshooting](#troubleshooting)

> **Image architecture:** the official image is multi-arch (`linux/amd64` and
> `linux/arm64`), so it runs natively on x86 servers as well as ARM hosts —
> Synology ARM models, Raspberry Pi (64-bit), and Apple Silicon.

---

## Quick deploy (VPS / any Docker host)

Start with `docker-compose.yml`. No git clone, no manual key: the server
encryption key is generated on first launch and persisted in the data volume, so
this works with zero configuration.

```bash
mkdir secret && cd secret
curl -O https://raw.githubusercontent.com/largerio/secret/main/docker-compose.yml
docker compose up -d
```

The container pulls `ghcr.io/largerio/secret:latest`, creates a persistent
Docker volume for your data, and serves the app on port `3000`.
Open `http://<your-host>:3000` and you're live.

**On your own domain, with HTTPS.** `docker-compose.tls.yml` adds Caddy, which
obtains and renews the certificate for you:

```bash
curl -O https://raw.githubusercontent.com/largerio/secret/main/docker-compose.tls.yml
echo "DOMAIN=secret.example.com" > .env

docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

Point the domain at this host first — Caddy proves ownership over ports 80 and
443. Only those two are published: the app itself is reachable through the proxy
alone, and `APP_URL` is derived from `DOMAIN`.

Already running a reverse proxy? Skip that file, set `APP_URL` in `.env`, and see
[Reverse proxy & HTTPS](#reverse-proxy--https).

> ⚠️ **The encryption key cannot be rotated.** Setting a different
> `SERVER_ENCRYPTION_KEY` on a running instance makes every stored note
> permanently unreadable — the server checks a fingerprint and refuses to start
> rather than let that pass silently. To manage the key yourself, pin it
> **before the very first launch**; otherwise it lives in the data volume at
> `.encryption_key`, so a volume backup already includes it. See
> [Container keeps restarting](#container-keeps-restarting--exits-immediately)
> if you hit a mismatch.

---

## One-click & platform deploys

### One-liner `docker run`

The fastest way to spin up a test instance — no files at all:

```bash
# Generate and SAVE the key (without it, notes are unreadable forever)
KEY=$(openssl rand -base64 32); echo "SERVER_ENCRYPTION_KEY=$KEY"

docker run -d --name secret -p 3000:3000 \
  -v secret-data:/app/data \
  -e SERVER_ENCRYPTION_KEY="$KEY" \
  -e APP_URL=http://localhost:3000 \
  ghcr.io/largerio/secret:latest
```

For a real deployment, set `APP_URL` to your public `https://` domain and put a
reverse proxy in front (see below).

### Coolify

Coolify gives you automatic HTTPS through its built-in proxy.

1. **New Resource** → **Docker Image** → `ghcr.io/largerio/secret:latest`
   (or **Docker Compose** and paste this repo's `docker-compose.yml`).
2. **Environment variables:** set `SERVER_ENCRYPTION_KEY` (generate one) and
   `APP_URL` to the domain Coolify assigns.
3. **Persistent Storage:** add a volume mounted at **`/app/data`**.
4. **Ports:** expose `3000`. Coolify provisions the TLS certificate automatically.

### Portainer

1. **Stacks** → **Add stack** → **Web editor**.
2. Paste this repo's `docker-compose.yml`.
3. Fill in the environment variables (at least `SERVER_ENCRYPTION_KEY` and
   `APP_URL`) in the editor, then **Deploy the stack**.

### Railway / Render (PaaS)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/largerio/secret)

Deploy directly from the image `ghcr.io/largerio/secret:latest`. A
[`render.yaml`](../render.yaml) blueprint is included — the button above deploys
it in one click; Render will then prompt you for the two required values
(`SERVER_ENCRYPTION_KEY` and `APP_URL`).

- ⚠️ **Attach a persistent disk/volume mounted at `/app/data`** — PaaS
  filesystems are ephemeral, so without it every redeploy wipes all notes.
  The included `render.yaml` already declares this disk. Note that persistent
  disks require a **paid** instance type on Render (the free tier has no disks).
- Set `APP_URL` to the platform-assigned domain.
- Set `SERVER_ENCRYPTION_KEY` yourself — it must be 32 random bytes, base64
  encoded (`openssl rand -base64 32`). A platform's generic "random value"
  generator won't match this format.

---

## Synology NAS (DSM 7 / Container Manager)

1. **Install Container Manager** from the DSM Package Center (if not already).
2. **Prepare a folder.** In File Station, create `docker/secret`. Put two files
   in it:
   - `docker-compose.yml` (from the link above)
   - `.env` — start from `.env.example`, then set `SERVER_ENCRYPTION_KEY`
     (`openssl rand -base64 32`) and `APP_URL` (e.g. `https://secret.example.com`).
3. **Create the project.** Container Manager → **Project** → **Create** →
   set the path to `docker/secret` and import the existing `docker-compose.yml`.
4. **Run it.** Build/Start the project — Container Manager pulls
   `ghcr.io/largerio/secret:latest` automatically.
5. **Access it.** Port `3000` is mapped to the NAS; browse to `http://<NAS-IP>:3000`.

### Synology notes & caveats

- The container runs as a **non-root user (uid 1001)** with a **read-only root
  filesystem**; only the `secret-data` volume and an in-memory `/tmp` are
  writable. This works out of the box on DSM with the named Docker volume — no
  permission tweaks needed.
- **Prefer the named volume `secret-data`** (the default). If you instead
  bind-mount a NAS folder (e.g. `/volume1/docker/secret/data:/app/data`), you
  must give uid 1001 write access first:
  ```bash
  sudo chown -R 1001:1001 /volume1/docker/secret/data
  ```
- To change the exposed port (e.g. if 3000 is taken), set `PORT=8080` in `.env`.

---

## Reverse proxy & HTTPS

This section is for a proxy you run yourself. If you don't have one,
`docker-compose.tls.yml` ([Quick deploy](#quick-deploy-vps--any-docker-host))
brings its own Caddy and there is nothing to configure here.

**Caddy** — certificates handled for you, `X-Forwarded-For` set on its own:

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

Two reminders:

- The body limit must clear `BODY_SIZE_LIMIT` (~101 MB) — not
  `MAX_CHUNKED_FILE_SIZE`, since large uploads are split into 4 MB chunks and no
  single request comes close to it.
- Update `APP_URL` in `.env` to your `https://` domain.

### Making rate limiting work behind a proxy

By default **every user shares a single rate-limit bucket**. The limits still
apply; they just apply to your whole instance at once, so one busy visitor can
exhaust them for everybody. The API logs a warning about this at startup.

The cause is structural: inside the container the web app proxies `/api` to the
API, so the API only ever sees `127.0.0.1` as its peer. It will not believe a
forwarded address unless you tell it which proxies to trust.

Three variables fix it:

```env
# The API: trust the address forwarded by the bundled web app.
TRUSTED_PROXIES=127.0.0.1/32

# The web app: derive the client address from the header your proxy sets,
# and say how many proxies sit in front of it (1 for a single Nginx/Traefik/
# Caddy/Cloudflare hop, 2 if Cloudflare fronts your own proxy, and so on).
ADDRESS_HEADER=X-Forwarded-For
XFF_DEPTH=1
```

`XFF_DEPTH` matters: `X-Forwarded-For` is a list a client can prefill, and only
the last entries — the ones your own proxies appended — are trustworthy. Set it
too high and a client can pick its own bucket; set it too low and everyone
shares one again.

Your proxy must actually set the header. Nginx needs it spelled out:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Real-IP $remote_addr;
```

Caddy and Traefik do it on their own.

**Verify it took effect** — this should answer `200`, not hang or 503:

```bash
docker compose exec app node -e "fetch('http://localhost:3000/api/health').then(r=>console.log(r.status))"
```

A container stuck in `health: starting` after setting `ADDRESS_HEADER` means the
health check cannot reach the app; check that `XFF_DEPTH` matches your actual
number of proxies. Requests that skip the proxy (like this health check) carry
no `X-Forwarded-For`, which is expected and handled — they simply fall back to
the shared bucket.

**On Synology** you can skip an external proxy and use the built-in one:
DSM → **Login Portal → Advanced → Reverse Proxy** → create a rule from
`secret.example.com:443` → `localhost:3000`. DSM manages the certificate.

---

## API keys (for the SDK)

Reads are open; writes are not. Browsers solve a Proof-of-Work challenge —
anything scripted (the [JS SDK](https://www.npmjs.com/package/@largerio/secret-sdk),
a backup job) needs a key you issue in `.env`:

```env
API_KEY=<openssl rand -base64 32>   # 32 characters minimum
# API_KEY_1=…                       # one per client, to revoke them separately
```

Then `docker compose up -d --force-recreate`. A key authorises writes only — it
grants no read access others don't have, and no ability to decrypt.

---

## Backup & restore

Everything lives in one Docker volume: the SQLite database (`secret.db` + WAL
files) and the encrypted `files/` directory.

Compose prefixes the volume with the project name (the folder you ran
`docker compose` from), so the real name is usually `secret_secret-data`.
Confirm the exact name first:

```bash
docker volume ls --format '{{.Name}}' | grep secret-data
```

Use that name in place of `<volume>` below.

### Back up

```bash
# Stop the container first so the API checkpoints the WAL on SIGTERM
docker compose stop

# Snapshot the volume into a tarball (tar preserves the uid 1001 ownership)
docker run --rm \
  -v <volume>:/data \
  -v "$PWD":/backup \
  alpine tar czf /backup/secret-backup.tgz -C /data .

docker compose start
```

Store `secret-backup.tgz` **together with your `SERVER_ENCRYPTION_KEY`** — the
data is useless without the key.

### Restore

```bash
# Let compose create the container and its volume first…
docker compose up -d
docker compose stop

# …then extract the backup into that same <volume>
# `./.[!.]*` too — the generated key is a dotfile, and leaving the fresh one
# behind next to restored notes stops the container from starting.
docker run --rm \
  -v <volume>:/data \
  -v "$PWD":/backup \
  alpine sh -c "cd /data && rm -rf ./* ./.[!.]* && tar xzf /backup/secret-backup.tgz"

docker compose start
```

Make sure the restored instance uses the **same** `SERVER_ENCRYPTION_KEY` as the
one that produced the backup, or the notes won't decrypt.

---

## Updating

```bash
docker compose pull     # fetch the latest image
docker compose up -d    # recreate the container
docker image prune -f   # clean up old layers
```

Your data lives in the volume, so updates never delete notes.

`docker-compose.yml` tracks `:latest` — the tip of `main`. In production, pin the
minor tag instead to get fixes without unreleased changes:

```yaml
image: ghcr.io/largerio/secret:1.0
```

Full tag list: [Pinning a version](../README.md#pinning-a-version).

---

## Deploying from CI

The GitHub Actions workflow in this repository builds the image, scans it, then
deploys over SSH. Two details are worth copying into any pipeline of your own.

**Deploy the digest, not the tag.** `:latest` and `:main` move. Between the scan
and the rollout, or between two rollouts, the tag can point somewhere else — and
once it has moved there is nothing left to roll back to. The workflow passes the
digest it just built and scanned:

```bash
SECRET_IMAGE="ghcr.io/largerio/secret@sha256:..." docker compose up -d
```

Your compose file needs to accept it, with a default so manual runs still work:

```yaml
image: ${SECRET_IMAGE:-ghcr.io/largerio/secret:latest}
```

**Wait for healthy, and roll back if it never is.** A container that starts and
then fails every request is a successful `docker compose up` — the exit code
says nothing about whether the app works. The workflow polls the health status
and, if it does not turn healthy, prints the last 50 log lines and restores the
image that was running before.

That is also why `docker image prune -f` is scoped: an unfiltered prune deletes
the previous image, which is the one a rollback needs.

A complete reference file is in
[`docs/examples/docker-compose.prod.yml`](examples/docker-compose.prod.yml).

---

## Troubleshooting

**First reflex:** look at the logs — every startup error is printed there.

```bash
docker compose logs -f        # or: docker logs -f secret
```

### Container keeps restarting / exits immediately

If no `SERVER_ENCRYPTION_KEY` is set, the container generates one on first launch
and stores it at `.encryption_key` inside the data volume — so this should not
happen on a fresh deployment.

If you **did** set the key explicitly and it is malformed, the logs will show:

```
ERROR: SERVER_ENCRYPTION_KEY must be 32 bytes (256 bits) encoded in base64.
Generate one with: openssl rand -base64 32
```

If the key is valid but is not the one that encrypted the existing notes:

```
ERROR: SERVER_ENCRYPTION_KEY does not match the key this database was created with.
```

Restore the original key — `docker compose exec app cat /app/data/.encryption_key`
prints the generated one. Only if the stored notes are expendable, start once with
`ALLOW_SERVER_KEY_CHANGE=true` to adopt the new key and abandon them.

Either way, unset `SERVER_ENCRYPTION_KEY` to fall back to the generated key, or set
a valid one in `.env`, then run `docker compose up -d --force-recreate`.

> An explicit key must be exactly **32 bytes encoded as base64** (44 characters
> ending in `=`). A random password or hex string will be rejected. The data
> volume must also be writable by uid 1001 so the auto-generated key can be saved
> (bind mounts: `chown -R 1001:1001 /path/to/data`).

### Changed `.env` but nothing happens

`docker compose up -d` only recreates the container when its configuration
changed. After editing `.env`, force a recreate:

```bash
docker compose up -d --force-recreate
```

### Port 3000 already in use

Set a different host port in `.env` (e.g. `PORT=8080`), then
`docker compose up -d --force-recreate`. The app will be reachable on
`http://<host>:8080`.

### "Permission denied" on `/app/data` (bind mounts)

Happens when you replaced the named volume with a bind-mounted folder. The
container runs as **uid 1001**, so the folder must be writable by it:

```bash
sudo chown -R 1001:1001 /path/to/your/data
```

### Container is `unhealthy`

Check `docker compose logs` for the underlying error, and verify the health
endpoint from inside the host:

```bash
curl http://localhost:3000/api/health
# {"status":"ok","checks":{"database":"ok","storage":"ok"}}
```

A failing check answers `503` and names the subsystem — `database` (the volume)
or `storage` (`FILES_PATH`, or the S3 credentials). The error itself is in the
logs, prefixed `[health]`.

### Uploads fail behind a reverse proxy

Increase the proxy's request body limit (`client_max_body_size` in Nginx) to at
least `BODY_SIZE_LIMIT` — see [Reverse proxy & HTTPS](#reverse-proxy--https).

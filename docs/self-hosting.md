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
[Secrets in files](#secrets-in-files) ·
[Backup & restore](#backup--restore) · [Storage cleanup](#storage-cleanup) ·
[Updating](#updating) ·
[Verifying the image](#verifying-the-image) ·
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

The container pulls `ghcr.io/largerio/secret:1` (the latest 1.x release),
creates a persistent Docker volume for your data, and serves the app on port
`3000`.
Open `http://<your-host>:3000` and you're live.

Plain HTTP is fine to try it out on a local network, but put HTTPS in front
before sharing real secrets: over HTTP the link, and so the decryption key,
crosses the network in clear, and browsers keep some features (one-click copy
among them) for secure pages.

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
> `.encryption_key`. Either way, back it up apart from the data
> ([Backup & restore](#backup--restore)). See
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
  ghcr.io/largerio/secret:1
```

For a real deployment, set `APP_URL` to your public `https://` domain and put a
reverse proxy in front (see below).

### Coolify

Coolify gives you automatic HTTPS through its built-in proxy.

1. **New Resource** → **Docker Image** → `ghcr.io/largerio/secret:1`
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

Deploy directly from the image `ghcr.io/largerio/secret:1`. A
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
   `ghcr.io/largerio/secret:1` automatically.
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

- The body limit must clear the largest single upload request,
  `MAX_FILE_SIZE × MAX_FILES_PER_NOTE + 1 MB` (~101 MB by default) — not
  `MAX_CHUNKED_FILE_SIZE`, since large uploads are split into 4 MB chunks and no
  single request comes close to it.
- Update `APP_URL` in `.env` to your `https://` domain.

### Making rate limiting work behind a proxy

Behind a reverse proxy, **every user shares the proxy's rate-limit bucket**
until you tell the web app where the client address is. The limits still apply;
they just apply to your whole instance at once, so one busy visitor can exhaust
them for everybody.

Inside the container the web app proxies `/api` to the API and passes on the
client address it resolved. The API trusts it out of the box (`TRUSTED_PROXIES`
defaults to `127.0.0.1/32` in the image). What the web app cannot guess is that
a reverse proxy sits in front of it: without being told, it sees that proxy's
address as the client's.

Two variables fix it:

```env
# The web app: derive the client address from the header your proxy sets,
# and say how many proxies sit in front of it (1 for a single Nginx/Traefik/
# Caddy/Cloudflare hop, 2 if Cloudflare fronts your own proxy, and so on).
ADDRESS_HEADER=X-Forwarded-For
XFF_DEPTH=1
```

Exposed directly, with no proxy in front, the instance already tells clients
apart and needs neither.

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

## Secrets in files

Each secret can be read from a file instead of a variable, the way Docker and
Kubernetes hand secrets to a container: append `_FILE` to the variable's name
and give the file's path.

| Variable | From a file |
|---|---|
| `SERVER_ENCRYPTION_KEY` | `SERVER_ENCRYPTION_KEY_FILE` |
| `API_KEY`, `API_KEY_1`… | `API_KEY_FILE`, `API_KEY_1_FILE`… |
| `S3_ACCESS_KEY_ID` | `S3_ACCESS_KEY_ID_FILE` |
| `S3_SECRET_ACCESS_KEY` | `S3_SECRET_ACCESS_KEY_FILE` |

The file holds the value alone; line breaks at its end are ignored. A variable
set together with its `_FILE`, or a file that is missing, unreadable or empty,
stops the server at startup, with an error that names the variable and the path
but never what the file holds.

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

`docker compose up -d` reads the override on its own. A command that lists its
files with `-f`, like the HTTPS setup's, must list it too:
`-f docker-compose.override.yml`.

**What this protects.** A value in `.env` or under `environment:` shows in
`docker inspect` and in the environment of the processes in the container. A
secret file keeps it out of both: only its path shows. Inside the container the
API reads the files; the web server gets neither the secrets nor the `_FILE`
variables, so a dependency of the web server that dumps its environment finds
nothing to leak. That is not isolation: both processes run as the same user, so
code running in the web server could still read the files, as it could read the
data volume.

**The server key.** Without `SERVER_ENCRYPTION_KEY` or
`SERVER_ENCRYPTION_KEY_FILE`, the image generates the key on first start and
keeps it in the data volume, at `/app/data/.encryption_key`, which it hands to
the API as `SERVER_ENCRYPTION_KEY_FILE`. (`KEY_FILE` moves that generated file;
it plays no part once you give a key either way.) Held in a secret instead, the
key no longer travels with the volume and its backups, so the server's
encryption layer also protects a stolen copy of the volume. To move a generated
key out of the volume:

```bash
mkdir -p secrets
docker compose exec -T app cat /app/data/.encryption_key > secrets/server_key
chmod 400 secrets/server_key && sudo chown 1001:1001 secrets/server_key
# With the override above in place:
docker compose up -d
# Once the instance is up and serves its notes:
docker compose exec app rm /app/data/.encryption_key
```

The server refuses to start on a key that does not match its notes, so a wrong
file fails loudly. Backups made before the move still hold the key.

Outside the image the API reads the same variables. On Kubernetes, mount the
Secret as a volume and point the `_FILE` variables at its files.

---

## Backup & restore

An instance is three things, backed up separately:

| What | Where | Lost without a backup |
|---|---|---|
| The database | `secret.db` in the volume (`DATABASE_PATH`) | Every note |
| The stored files | `files/` in the volume (`FILES_PATH`), or the S3 bucket | Every note with files |
| The server key | `SERVER_ENCRYPTION_KEY`, or the generated `.encryption_key` in the volume (`KEY_FILE`) | Everything: each note is sealed with it, and the server refuses to start with another one |

The key never changes, so it is backed up once, and kept apart from the data: in
a password manager or a secret store. A backup that holds the data and the key
together is protected by the end-to-end encryption alone.

Compose prefixes the volume with the project name (the folder you ran
`docker compose` from), so the real name is usually `secret_secret-data`.
Confirm the exact name first:

```bash
docker volume ls --format '{{.Name}}' | grep secret-data
```

Use that name in place of `<volume>` below.

### Back up

The database first, then the files. A file stored in between has no note in that
database copy: after a restore, the [storage sweep](#storage-cleanup) removes it.
A note whose file went in between was read to its limit, deleted or expired: it
was meant to go. In the other order, the notes created in between would come
back without their files.

**The database**, while the app runs:

```bash
docker compose exec app node apps/api/dist/backup.js /app/data/backup.db
docker compose cp app:/app/data/backup.db ./secret-$(date +%F).db
docker compose exec app rm /app/data/backup.db
```

The command copies the database at `DATABASE_PATH` with SQLite's `VACUUM INTO`:
one consistent snapshot, taken without blocking the app, with no trace of the
notes already deleted. It checks the copy, writes it under a temporary name and
renames it into place, never overwrites an existing file, and exits with a
non-zero code when anything fails, so a scheduled job notices. The container's
root filesystem is read-only, so the copy is written to the volume first, then
moved out.

The copy is a single SQLite file. It keeps the schema version, the instance
identity the sweep relies on, and the server key's fingerprint, so it restores
as is, on the version of Secret that made it or a later one (which migrates it
at startup). Outside Docker, from a build of the repository:
`DATABASE_PATH=/path/to/secret.db node apps/api/dist/backup.js <destination>`.

**The files**, right after. On local storage:

```bash
docker run --rm -v <volume>:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/secret-files-$(date +%F).tgz -C /data files
```

On S3, copy the `notes/` prefix with your provider's tools (`aws s3 sync`,
`rclone`).

### Keeping backups

A backup holds every note as it was. A note burned by its last read since then,
or deleted with its deletion link, is still in it, and a restore brings it back
for anyone who still has the link. Hence:

- **Keep backups no longer than `MAX_EXPIRY`** (30 days by default), and shorter
  when you can: a week of daily copies covers most needs. Every note in an older
  backup has expired, so it restores nothing, and only holds ciphertexts and
  metadata.
- **No versioning, no long-lived snapshots.** A versioned bucket keeps every
  deleted file: see [S3 bucket settings](#s3-bucket-settings). Snapshots of the
  volume (ZFS, Btrfs, a VM, Synology Snapshot Replication) are backups too, and
  need the same limit.
- **Encrypt them** before they leave the host (`age`, `gpg`, or a backup tool
  that encrypts, such as restic or borg), with a key of their own, stored apart
  from the server key.

### Restore

1. Stop the app with `docker compose stop`. On a new host, run
   `docker compose up -d` first, so that compose creates the volume.
2. Put the database back. Delete the `-wal` and `-shm` files next to it: left
   there, SQLite would replay the old log onto the restored database.

   ```bash
   docker run --rm -v <volume>:/data -v "$PWD":/backup alpine sh -c '
     rm -f /data/secret.db-wal /data/secret.db-shm &&
     cp /backup/secret-<date>.db /data/secret.db &&
     chown 1001:1001 /data/secret.db'
   ```

3. If the files are lost too, restore the copy taken after that database (a later
   one also works). On local storage:

   ```bash
   docker run --rm -v <volume>:/data -v "$PWD":/backup alpine \
     tar xzf /backup/secret-files-<date>.tgz -C /data
   ```

   On S3, copy `notes/` back into the bucket. Files the database does not know
   can stay: the sweep removes them.
4. Bring back the key: set `SERVER_ENCRYPTION_KEY` in `.env`, or write the saved
   key over `.encryption_key` in the volume (owned by uid 1001, mode `600`). A new
   volume holds a key generated on its first start: it is not the one you need.
5. Run `docker compose start` and watch `docker compose logs -f`. A wrong key
   stops the start with an explicit error.

An archive of the whole volume, made with the app stopped as this guide used to
advise, restores in one step: empty the volume (`rm -rf ./* ./.[!.]*`, so that
no generated key stays behind), then extract the archive into it.

### After a restore

- Notes created after the backup are gone: their links find nothing, and the
  sweep removes their files.
- Notes read to their limit or deleted since the backup are back, readable by
  anyone who still has the link until they expire, with their read count as it
  was. No record says which ones: a deletion leaves none.
- Notes that have expired since stay gone: the cleanup job deletes them, and an
  expired note is never served.

On an instance used for one-time secrets, tell its users: a link opened before
the backup date may open again, and its deletion link still removes it.

### What a stolen backup reveals

Not the contents: notes are encrypted in the browser, and the key is in the link's
fragment, which never reaches the server. The payloads, in the database and in
the files, are also sealed with the server key: stolen without it, they are
opaque even before the end-to-end layer comes into play.

A backup does hold, in clear:

- the metadata listed in [What the server can see](../SECURITY.md#what-the-server-can-see):
  sizes, number of files, password set or not, read limits and reads so far,
  creation and expiry times;
- the note ids, the half of each link that decrypts nothing;
- each note's deletion token: whoever holds the backup can delete those notes
  while they last.

---

## Storage cleanup

A note's files are deleted from storage as soon as the note goes: read to its
limit, deleted with its token, or expired. Each deletion is recorded in the
database first, so a storage outage or a restart in the middle cannot lose it:
the cleanup job retries it, with backoff, for a little over a day.

What still slips through is removed by a daily sweep: any stored file older than
a day that no note, upload or pending deletion points to. The first sweep runs
ten minutes after startup. It logs a line when it removes something.

For its first day on a storage, a database's sweep deletes nothing: it logs how
many stored notes it does not know (`storage sweep on trial`). A large count on
an instance that just started means it runs on the wrong database, such as a new
volume after a renamed compose project: stop it before the day is out.

### One storage location per instance

The sweep trusts the database to know every note, so the bucket (or
`FILES_PATH`) must belong to one instance. To enforce it, each database records
its claim in the storage at startup, whether it sweeps or not (`instances/<id>`
in the bucket, `FILES_PATH/.instances/<id>` on disk). When the sweep finds
another claim it deletes nothing and logs a warning instead:

```
storage sweep skipped: another database has claimed this storage
```

This happens when two instances share a bucket, and also when an instance starts
on an empty database while the storage still holds the notes of a database that
claimed it: a lost volume, a renamed compose project, or a database backup older
than the first claim. Point each instance at its own bucket, or restore the right
database and delete the claim the wrong one left. If the other database is gone
for good, delete its claim; the next sweep resumes.

A copy of a database carries its claim: an instance restored from another's
volume (a staging copy of production, say) cannot be told apart and must get a
bucket of its own.

To turn the sweep off, set `STORAGE_RECONCILE=false`. Deletions are still
retried; only the files they miss stay behind.

### S3 bucket settings

- **Versioning off.** On a versioned bucket a deletion only hides the object:
  the ciphertext of every note stays in its earlier versions. If versioning must
  stay on, expire noncurrent versions after a day.
- **No object lock or retention rule**: notes must be deletable at any time.
- **Permissions.** The key needs to read, write, delete and list objects under
  `notes/`, and to write and list them under `instances/`.
- **A lifecycle rule** as a safety net. Incomplete multipart uploads, left when
  the server stops in the middle of a large file, are invisible to the sweep:
  abort them after a day. And since no note outlives the 30-day retention
  ceiling, anything under `notes/` older than 31 days is garbage. Keep the rule
  to that prefix: `instances/` holds the claims.

With the AWS CLI (other S3 servers such as Cloudflare R2, Scaleway or Garage
accept the same two actions; check your provider's documentation):

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

## Updating

```bash
docker compose pull     # fetch the latest image
docker compose up -d    # recreate the container
docker image prune -f   # clean up old layers
```

Your data lives in the volume, so updates never delete notes.

`docker-compose.yml` tracks `:1`: every 1.x release, rebuilt between releases
on the latest base image. Pin an exact release such as
`ghcr.io/largerio/secret:1.2.1` for a fully reproducible deployment: that tag
never changes.

Full tag list: [Pinning a version](../README.md#pinning-a-version).

---

## Verifying the image

Every image this repository publishes is signed by the GitHub Actions workflow
that built it, once the image has passed the vulnerability scan and the smoke
test. It also carries a [SLSA](https://slsa.dev) build provenance attestation:
the workflow, commit and run that produced it. Both are keyless
[Sigstore](https://www.sigstore.dev) signatures: there is no public key to
fetch, the signing certificate names the workflow, and each signature is
recorded in the public Rekor transparency log.

Verify a digest, then deploy that same digest: a tag can move between two
commands.

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

Then deploy `ghcr.io/largerio/secret@sha256:…`, the digest you verified: on the
`image:` line of `docker-compose.yml`, or as `SECRET_IMAGE` (see
[Deploying from CI](#deploying-from-ci)).

**What the identity pins.** Two workflows build images, both from `main`:
`deploy.yml` builds `main`, and so every release; `rebuild-release.yml`
rebuilds the release line on a newer base image each week. A rebuild's
provenance names that workflow and the `main` commit it ran from; the release
it rebuilt is in the image's `org.opencontainers.image.revision` label.

**The SBOM is covered too.** The signature is over the image index, which lists
the SBOM and BuildKit's own provenance by digest:

```bash
docker buildx imagetools inspect ghcr.io/largerio/secret:1 --format '{{json .SBOM}}'
```

On Kubernetes, an admission policy (Kyverno, Sigstore policy-controller) can
require the same issuer and identity before a pod starts.

Signing starts with `1.4.0`. `1.3.2` and older were published unsigned, and an
exact tag never changes, so theirs cannot be verified.

---

## Deploying from CI

The GitHub Actions workflow in this repository builds the image, scans,
smoke-tests and signs it, then deploys over SSH. Two details are worth copying
into any pipeline of your own.

**Deploy the digest, not the tag.** `:1` and `:main` move. Between the scan
and the rollout, or between two rollouts, the tag can point somewhere else — and
once it has moved there is nothing left to roll back to. The workflow passes the
digest it just built and scanned:

```bash
SECRET_IMAGE="ghcr.io/largerio/secret@sha256:..." docker compose up -d
```

Your compose file needs to accept it, with a default so manual runs still work:

```yaml
image: ${SECRET_IMAGE:-ghcr.io/largerio/secret:1}
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
least `MAX_FILE_SIZE × MAX_FILES_PER_NOTE + 1 MB` (~101 MB by default) — see
[Reverse proxy & HTTPS](#reverse-proxy--https).

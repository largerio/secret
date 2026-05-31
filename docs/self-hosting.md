# Self-Hosting Guide

Deploy your own Secret instance in minutes — no clone, no build. The official
image is published to [`ghcr.io/largerio/secret`](https://ghcr.io/largerio/secret)
and runs as a single container.

- [Quick deploy (VPS / any Docker host)](#quick-deploy-vps--any-docker-host)
- [Synology NAS (DSM 7 / Container Manager)](#synology-nas-dsm-7--container-manager)
- [Reverse proxy & HTTPS](#reverse-proxy--https)
- [Backup & restore](#backup--restore)
- [Updating](#updating)

---

## Quick deploy (VPS / any Docker host)

You only need two files — `docker-compose.yml` and `.env`. No git clone required.

```bash
mkdir secret && cd secret

# Grab the compose file and an env template
curl -O https://raw.githubusercontent.com/largerio/secret/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/largerio/secret/main/.env.example

# Generate the REQUIRED server encryption key and paste it into .env
openssl rand -base64 32
#   → set SERVER_ENCRYPTION_KEY=<output> in .env

# Set your public URL in .env, e.g.
#   APP_URL=https://secret.example.com

docker compose up -d
```

The container pulls `ghcr.io/largerio/secret:latest`, creates a persistent
`secret-data` volume, and serves the app on port `3000`.
Open `http://<your-host>:3000` and you're live.

> ⚠️ **Never change `SERVER_ENCRYPTION_KEY` after the first launch** — all
> existing notes become permanently unreadable. Back it up somewhere safe.

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

Put a reverse proxy in front to terminate TLS. Caddy and Nginx examples are in
the [main README](../README.md#reverse-proxy). Two reminders:

- Set `client_max_body_size` (Nginx) / request body limits to at least
  `MAX_CHUNKED_FILE_SIZE` (default 500 MB) so large uploads aren't rejected.
- Update `APP_URL` in `.env` to your `https://` domain.

**On Synology** you can skip an external proxy and use the built-in one:
DSM → **Login Portal → Advanced → Reverse Proxy** → create a rule from
`secret.example.com:443` → `localhost:3000`. DSM manages the certificate.

---

## Backup & restore

Everything lives in the `secret-data` Docker volume: the SQLite database
(`secret.db` + WAL files) and the encrypted `files/` directory.

### Back up

```bash
# Stop the container first so the API checkpoints the WAL on SIGTERM
docker compose stop

# Snapshot the volume into a tarball
docker run --rm \
  -v secret-data:/data \
  -v "$PWD":/backup \
  alpine tar czf /backup/secret-backup.tgz -C /data .

docker compose start
```

Store `secret-backup.tgz` **together with your `SERVER_ENCRYPTION_KEY`** — the
data is useless without the key.

### Restore

```bash
# Recreate the volume from the tarball, then start fresh
docker volume create secret-data
docker run --rm \
  -v secret-data:/data \
  -v "$PWD":/backup \
  alpine sh -c "cd /data && tar xzf /backup/secret-backup.tgz"

docker compose up -d
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

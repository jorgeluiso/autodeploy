# Auto-Deploy

A generic GitHub webhook listener that auto-deploys repositories via a repo-provided deploy script or Docker Compose.

A small Node webhook server runs on the Docker host and listens for GitHub `push` events on `main`. On a valid event it runs:

```bash
git -C /base-dir/<repo-name> pull --ff-only origin main
bash /base-dir/<repo-name>/scripts/deploy.sh   # when present
```

If the repo does not provide `scripts/deploy.sh`, the listener falls back to Docker Compose:

```bash
docker compose build --pull
docker compose up -d --force-recreate --remove-orphans
```

The server lives at `scripts/auto-deploy-webhook.js` and is supervised by systemd. `scripts/install.sh` handles first-time service registration, and `scripts/deploy.sh` renders the systemd unit from `scripts/auto-deploy.service` during updates, so checked-in files do not need deployment-specific paths.

Reserved port: **`3091`**.

## Architecture

```
GitHub push to main
        │
        ▼  HTTPS POST (HMAC-SHA256 signed)
${PUBLIC_DEPLOY_URL}/
        │
        ▼  Cloudflare tunnel
http://${SSH_HOST}:${PORT}  (auto-deploy-webhook.js on host, systemd)
        │
        ▼  git pull --ff-only + scripts/deploy.sh or docker compose
Target container rebuilt & restarted
```

## One-time server setup

All commands run on the LXC host as `root` (or with `sudo`).

### 1. Install Node ≥ 20 (if missing)

```bash
node -v || curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
```

### 2. Clone this repo at `/base-dir/autodeploy`

```bash
git clone https://github.com/jorgeluiso/autodeploy.git /base-dir/autodeploy
cd /base-dir/autodeploy
cp .env.example .env   # then fill in real values
```

### 3. Pick a webhook secret

```bash
openssl rand -hex 32
```

Save this value — you'll paste it into both the server env file **and** the GitHub webhook form.

### 4. Create `/etc/auto-deploy.env`

This listener is **generic**. It can auto-deploy any repository as long as it lives in `/base-dir/<repo-name>` (or your configured `BASE_DIR`), has `scripts/deploy.sh` or a `docker-compose.yml` file, and uses the same shared secret.

```
GITHUB_WEBHOOK_SECRET=<paste the value from step 3>
BASE_DIR=/base-dir
APP_DIR=/base-dir/autodeploy
NODE_BIN=/usr/bin/node
BRANCH=main
PORT=3091
# Used by child git/deploy commands; set this to the service user's home directory.
HOME=/path/to/service-user-home
LOG_TIME_ZONE=America/Los_Angeles
# Optional; defaults to /base-dir/autodeploy/data/logs/deploy.log when installed at /base-dir/autodeploy.
LOG_FILE=/base-dir/autodeploy/data/logs/deploy.log
# Optional; defaults to scripts/deploy.sh, relative to each target repo.
DEPLOY_SCRIPT=scripts/deploy.sh
SERVICE_NAME=auto-deploy
ENV_FILE=/etc/auto-deploy.env
# Documentation/setup values used for your webhook and tunnel.
PUBLIC_DEPLOY_URL=https://deploy.example.com
SSH_HOST=127.0.0.1
SSH_USER=base-dir
```

For example, `repository` can define `/base-dir/repository/scripts/deploy.sh` with its own serial Docker rollout logic. After each accepted push, autodeploy fast-forwards `/base-dir/repository` from `origin/main` and runs `bash /base-dir/repository/scripts/deploy.sh` from `/base-dir/repository`.

Lock it down:

```bash
install -m 600 .env /etc/auto-deploy.env
chmod 600 /etc/auto-deploy.env
mkdir -p /base-dir/autodeploy/data/logs
touch /base-dir/autodeploy/data/logs/deploy.log
chmod 640 /base-dir/autodeploy/data/logs/deploy.log
```

### 5. Install and start the systemd service

```bash
bash /base-dir/autodeploy/scripts/install.sh
systemctl status auto-deploy
```

After the first install, `scripts/deploy.sh` is the canonical update script for this repo. The webhook can run it just like any other repo-provided deploy script.

Tail logs with:

```bash
journalctl -u auto-deploy -f
# or
tail -f /base-dir/autodeploy/data/logs/deploy.log
```

Health check:

```bash
curl http://127.0.0.1:3091/health   # => ok
```

### 6. Route through Cloudflare Tunnel

Use a dedicated subdomain from `PUBLIC_DEPLOY_URL` in your Cloudflare Tunnel dashboard:

- **Public Hostname:** the hostname from `PUBLIC_DEPLOY_URL`, for example `deploy.example.com`
- **Service:** `http://${SSH_HOST}:${PORT}`

Verify externally:

```bash
curl "$PUBLIC_DEPLOY_URL/health"   # => ok
```

## GitHub webhook setup

1. Go to **github.com/jorgeluiso/<your-repo> → Settings → Webhooks → Add webhook**.
2. Fill in:
   - **Payload URL:** the value of `PUBLIC_DEPLOY_URL`
   - **Content type:** `application/json`
   - **Secret:** the value from step 3 above (must match exactly).
   - **SSL verification:** Enable SSL verification.
   - **Which events?** _Just the push event._
   - **Active:** checked.
3. Click **Add webhook**.

## Troubleshooting

| Symptom                                  | Likely cause                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `401 bad signature` in logs            | `GITHUB_WEBHOOK_SECRET` mismatch between `/etc/auto-deploy.env` and GitHub.      |
| `ignoring push to refs/heads/...`      | Push wasn't to the configured `BRANCH` (default: main).                           |
| `step failed with code 1` on `git pull` | The target repo has local changes or cannot fast-forward. SSH in and clean it up. |
| `scripts/deploy.sh` step fails         | Run the script manually from the target repo and check its logs.                  |
| `docker compose` step fails            | Check `.env` exists in the target repo and is readable.                           |

## Disabling

```bash
systemctl disable --now auto-deploy
```

To rotate the secret: update `/etc/auto-deploy.env`, `systemctl restart auto-deploy`, then update the secret in the GitHub webhook form.

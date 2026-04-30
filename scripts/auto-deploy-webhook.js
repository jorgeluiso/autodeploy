#!/usr/bin/env node
/*
 * Generic GitHub deploy webhook listener.
 *
 * Runs on the Docker host. On a valid `push` event to `refs/heads/${BRANCH}`, runs:
 *
 *     git -C $BASE_DIR/$REPO_NAME pull --ff-only origin $BRANCH
 *     ./scripts/deploy.sh     # when present in the target repo
 *
 * If no deploy script exists, it falls back to:
 *
 *     docker compose build --pull
 *     docker compose up -d --force-recreate
 *
 * Special case for 'autodeploy' repo:
 *     git -C $BASE_DIR/autodeploy pull --ff-only origin $BRANCH
 *     systemctl restart auto-deploy
 */

const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3091);
const BASE_DIR = process.env.BASE_DIR;
const BRANCH = process.env.BRANCH || "main";
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const LOG_FILE =
  process.env.LOG_FILE || path.join(__dirname, "..", "data", "logs", "deploy.log");
const COMPOSE_FILE = "docker-compose.yml";
const DEPLOY_SCRIPT = process.env.DEPLOY_SCRIPT || "scripts/deploy.sh";

if (!SECRET || !BASE_DIR) {
  console.error("GITHUB_WEBHOOK_SECRET and BASE_DIR are required");
  process.exit(1);
}

const startedAt = new Date();
const activeDeploys = new Set();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // logging to file is best-effort
  }
}

function verifySignature(rawBody, header) {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    "sha256=" +
      crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex"),
  );
  const received = Buffer.from(header);
  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function healthPayload() {
  return {
    status: "ok",
    time: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    activeDeploys: activeDeploys.size,
  };
}

function runDeploy(repoName) {
  const repoDir = path.join(BASE_DIR, repoName);
  const isSelf = repoName === "autodeploy";

  if (!fs.existsSync(repoDir)) {
    log(`error: directory ${repoDir} does not exist, skipping deploy`);
    return;
  }

  if (activeDeploys.has(repoName)) {
    log(`deploy for ${repoName} already in progress, skipping`);
    return;
  }

  activeDeploys.add(repoName);
  log(`[${repoName}] deploy started in ${repoDir}`);

  const steps = isSelf
    ? [
        ["git pull", "git", ["-C", repoDir, "pull", "--ff-only", "origin", BRANCH]],
        ["service restart", "systemctl", ["restart", "auto-deploy"]],
      ]
    : [
        ["git pull", "git", ["-C", repoDir, "pull", "--ff-only", "origin", BRANCH]],
        ["deploy", "__deploy__", []],
      ];

  const runStep = (i) => {
    if (i >= steps.length) {
      activeDeploys.delete(repoName);
      log(`[${repoName}] deploy finished ok`);
      return;
    }
    let [label, cmd, args] = steps[i];
    if (cmd === "__deploy__") {
      const deployScript = path.join(repoDir, DEPLOY_SCRIPT);
      const composeFile = path.join(repoDir, COMPOSE_FILE);

      if (fs.existsSync(deployScript)) {
        log(`[${repoName}] deploy strategy: script ${deployScript}`);
        label = "deploy script";
        cmd = "bash";
        args = [deployScript];
      } else if (fs.existsSync(composeFile)) {
        log(`[${repoName}] deploy strategy: docker compose ${composeFile}`);
        steps.splice(
          i,
          1,
          ["docker compose build", "docker", ["compose", "build", "--pull"]],
          [
            "docker compose up",
            "docker",
            ["compose", "up", "-d", "--force-recreate", "--remove-orphans"],
          ],
        );
        runStep(i);
        return;
      } else {
        activeDeploys.delete(repoName);
        log(
          `error: neither deploy script ${deployScript} nor compose file ${composeFile} exists, aborting`,
        );
        return;
      }
    }
    log(`[${repoName}] ${label} started: ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) =>
      log(`[${repoName}] ${b.toString().trimEnd()}`),
    );
    child.stderr.on("data", (b) =>
      log(`[${repoName}] ${b.toString().trimEnd()}`),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        activeDeploys.delete(repoName);
        log(`[${repoName}] ${label} failed with code ${code}, aborting deploy`);
        return;
      }
      log(`[${repoName}] ${label} finished ok`);
      runStep(i + 1);
    });
  };

  runStep(0);
}

const server = http.createServer((req, res) => {
  log(`${req.method} ${req.url} (Host: ${req.headers.host})`);

  if (req.method === "GET" && req.url === "/health") {
    writeJson(res, 200, healthPayload());
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const sig = req.headers["x-hub-signature-256"];
    const event = req.headers["x-github-event"];

    if (!verifySignature(raw, sig)) {
      log("rejected: bad signature");
      res.writeHead(401);
      res.end("bad signature");
      return;
    }

    if (event === "ping") {
      log("ping ok");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pong");
      return;
    }

    if (event !== "push") {
      res.writeHead(204);
      res.end();
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.writeHead(400);
      res.end("invalid json");
      return;
    }

    const repoName = payload.repository?.name;
    if (!repoName) {
      res.writeHead(400);
      res.end("missing repository name");
      return;
    }

    if (payload.ref !== `refs/heads/${BRANCH}`) {
      log(`[${repoName}] ignoring push to ${payload.ref}`);
      res.writeHead(204);
      res.end();
      return;
    }

    log(
      `[${repoName}] update received: push ${payload.before?.slice(0, 7)}..${payload.after?.slice(0, 7)} to ${payload.ref} by ${payload.pusher?.name}`,
    );
    res.writeHead(202, { "content-type": "text/plain" });
    res.end("accepted");
    runDeploy(repoName);
  });
});

server.listen(PORT, () => {
  log(
    `multi-repo deploy listener on :${PORT} (baseDir=${BASE_DIR} branch=${BRANCH})`,
  );
});

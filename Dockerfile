FROM oven/bun:1

# Install Docker CLI and Git because the worker needs to execute commands
RUN apt-get update && \
    apt-get install -y docker.io git && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package and lock files first to leverage Docker cache
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install

# Copy everything else
COPY . .

# Generate Prisma client
RUN bun run generate

# Expose the application port
EXPOSE 8080

# Start the application using Bun
CMD ["bun", "run", "src/index.ts"]

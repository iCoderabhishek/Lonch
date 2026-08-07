FROM oven/bun:alpine

# Install Docker CLI and Git because the worker needs to execute commands
RUN apk update && \
    apk add --no-cache docker-cli git

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

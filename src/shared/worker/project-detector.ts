import fs from "fs/promises";
import path from "path";
import { prisma } from "../libs/prisma";
import type { Project } from "@prisma/client";

export const autoDetectConfig = async <T extends Project>(tempDir: string, project: T): Promise<T> => {
    let newBaseImage = project.baseImage;
    let newInstallCommand = project.installCommand;
    let newBuildCommand = project.buildCommand;
    let newStartCommand = project.startCommand;
    let newFramework = project.framework;

    const workingDir = project.rootDirectory ? path.join(tempDir, project.rootDirectory.replace(/^\/+/, '')) : tempDir;

    let updated = false;

    // Helper to check if file exists
    const fileExists = async (filename: string) => {
        try {
            await fs.access(path.join(workingDir, filename));
            return true;
        } catch {
            return false;
        }
    };

    // NodeJS detection
    if (await fileExists("package.json")) {
        const hasBunLock = await fileExists("bun.lockb") || await fileExists("bun.lock");
        const hasYarnLock = await fileExists("yarn.lock");
        const hasPnpmLock = await fileExists("pnpm-lock.yaml");

        if (!newBaseImage || newBaseImage === "node:20-alpine") {
            newBaseImage = hasBunLock ? "oven/bun:1-alpine" : "node:22-alpine";
            updated = true;
        }

        if (!newInstallCommand) {
            newInstallCommand = hasBunLock ? "bun install" : hasYarnLock ? "yarn install" : hasPnpmLock ? "pnpm install" : "npm install";
            updated = true;
        }

        try {
            const pkgRaw = await fs.readFile(path.join(workingDir, "package.json"), "utf8");
            const pkg = JSON.parse(pkgRaw);
            const scripts = pkg.scripts || {};

            if (!newBuildCommand) {
                if (scripts.build) {
                    newBuildCommand = hasBunLock ? "bun run build" : hasYarnLock ? "yarn build" : hasPnpmLock ? "pnpm build" : "npm run build";
                    updated = true;
                }
            }

            if (!newStartCommand) {
                if (scripts.start) {
                    newStartCommand = hasBunLock ? "bun start" : hasYarnLock ? "yarn start" : hasPnpmLock ? "pnpm start" : "npm start";
                    updated = true;
                } else if (scripts.dev && project.type === "STATIC") {
                    newStartCommand = hasBunLock ? "bun run dev" : hasYarnLock ? "yarn dev" : hasPnpmLock ? "pnpm dev" : "npm run dev";
                    updated = true;
                }
            }

            if (!newFramework) {
                if (pkg.dependencies?.next || pkg.devDependencies?.next) newFramework = "Next.js";
                else if (pkg.dependencies?.react || pkg.devDependencies?.react) newFramework = "React";
                else if (pkg.dependencies?.vue || pkg.devDependencies?.vue) newFramework = "Vue";
                else if (pkg.dependencies?.express) newFramework = "Express";
                else newFramework = "NodeJS";
                updated = true;
            }
        } catch (e) {
            console.error("Failed to parse package.json for auto-detect", e);
        }
    }
    // Python detection
    else if (await fileExists("requirements.txt") || await fileExists("main.py")) {
        if (!newBaseImage) {
            newBaseImage = "python:3.11-slim";
            updated = true;
        }
        if (!newInstallCommand && await fileExists("requirements.txt")) {
            newInstallCommand = "pip install -r requirements.txt";
            updated = true;
        }
        if (!newStartCommand && await fileExists("main.py")) {
            newStartCommand = "python main.py";
            updated = true;
        }
        if (!newFramework) {
            newFramework = "Python";
            updated = true;
        }
    }
    // Go detection
    else if (await fileExists("go.mod") || await fileExists("main.go")) {
        if (!newBaseImage) {
            newBaseImage = "golang:1.22-alpine";
            updated = true;
        }
        if (!newInstallCommand && await fileExists("go.mod")) {
            newInstallCommand = "go mod download";
            updated = true;
        }
        if (!newBuildCommand) {
            newBuildCommand = "go build -o main .";
            updated = true;
        }
        if (!newStartCommand) {
            newStartCommand = "./main";
            updated = true;
        }
        if (!newFramework) {
            newFramework = "Go";
            updated = true;
        }
    }

    if (updated) {
        const updatedProject = await prisma.project.update({
            where: { id: project.id },
            data: {
                baseImage: newBaseImage,
                installCommand: newInstallCommand,
                buildCommand: newBuildCommand,
                startCommand: newStartCommand,
                framework: newFramework
            }
        });
        return { ...project, ...updatedProject } as T;
    }

    return project;
};

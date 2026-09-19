/**
 * Disk guards for the build host.
 *
 * WHY THIS EXISTS
 * Builds run on a single VM: we `git clone` into /tmp/builds and shell out to `docker build`
 * on the host daemon. Both eat the same root filesystem, and nothing used to give it back.
 * `docker rmi <tag>` in the worker's finally block only drops the final tag; the intermediate
 * layers and the BuildKit cache stay. Across repeated builds that is a one-way ratchet.
 *
 * It bit us on a Python face-recognition repo: pip had no dlib wheel, so it compiled from
 * source, ran 13 minutes, then the assembler died with "No space left on device" writing to
 * /tmp. The user saw a FAILED badge and no explanation, so they recreated the project four
 * times, each attempt burning another full set of layers.
 *
 * Two guards, used by both build workers:
 *   ensureDiskSpaceForBuild() before the clone  -> refuse in seconds instead of failing in minutes
 *   reclaimDockerDisk()       in the finally    -> give the space back after every build
 */

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { BUILD_CACHE_KEEP_MB, MIN_FREE_DISK_MB } from "../libs/env-lib";
import { workerLog } from "./logger";

const execFileAsync = promisify(execFile);

const MB = 1024 * 1024;

export const formatBytes = (bytes: number) => {
    if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
    return `${Math.round(bytes / MB)} MB`;
};

/**
 * statfs() throws ENOENT on a path that does not exist, and /tmp/builds is only created by the
 * first clone. Rather than special-casing that, climb to the nearest existing ancestor: it sits
 * on the same filesystem, so the free-space number is identical.
 *
 * The loop terminates because path.dirname() is a fixed point at the root ("/" on Linux,
 * "D:\\" on Windows), which we detect and bail on.
 */
const resolveExistingPath = async (target: string): Promise<string | null> => {
    let current = path.resolve(target);

    while (true) {
        const exists = await fs.access(current).then(() => true).catch(() => false);
        if (exists) return current;

        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
};

/**
 * Free bytes on the filesystem holding `target`, or null if we cannot tell.
 *
 * Uses fs.statfs rather than shelling out to `df`, which keeps it dependency-free and avoids
 * parsing df's locale-dependent output. Verified present in Bun.
 *
 * bavail, not bfree: bfree counts blocks reserved for root that an unprivileged build cannot
 * actually touch, which would make us optimistic by ~5% of the volume.
 *
 * On null, callers must SKIP the check, not fail the build. A platform that cannot report free
 * space is not a reason to stop deploying; the old behaviour (build until it explodes) is still
 * the correct fallback.
 *
 * Note the worker runs inside a container, so this measures the container's view. That is what
 * we want: docker-compose bind-mounts the host's /tmp/builds in, so passing BUILD_ROOT here
 * reports real host free space. Pass a container-local path and you will measure the wrong
 * filesystem.
 */
export const getFreeDiskBytes = async (target: string): Promise<number | null> => {
    const existing = await resolveExistingPath(target);
    if (!existing) return null;

    try {
        const stats = await fs.statfs(existing);
        return Number(stats.bsize) * Number(stats.bavail);
    } catch {
        return null;
    }
};

/** Never throws. Cleanup is best-effort: a failed prune must not fail a successful deploy. */
const runDocker = async (args: string[]) => {
    try {
        const { stdout } = await execFileAsync("docker", args, { maxBuffer: 10 * MB });
        return { ok: true, output: stdout.trim() };
    } catch (error: any) {
        return { ok: false, output: String(error?.stderr || error?.message || "").trim() };
    }
};

/**
 * Prune output is a list of every deleted ID followed by "Total reclaimed space: X".
 * We only want the total; the IDs would bury the user's build log.
 */
const reclaimedLine = (output: string) => {
    const line = output.split("\n").map(l => l.trim()).find(l => l.toLowerCase().startsWith("total reclaimed space"));
    return line || "";
};

/**
 * Give disk back to the host. Best-effort throughout: every failure is logged and skipped.
 *
 * mode "routine" — runs in the finally block of every build.
 *   image prune -f      drops dangling layers the build left behind (untagged, unreferenced).
 *   builder prune       trims the BuildKit cache to BUILD_CACHE_KEEP_MB. Capped rather than
 *                       emptied, because that cache is what makes the second build of a repo
 *                       skip its apt/pip layers. Wiping it every time would undo the win from
 *                       dropping --no-cache.
 *
 * mode "aggressive" — only from the preflight, when we are already under the floor and the
 * alternative is refusing the build. Correctness of future cache hits stops mattering:
 *   builder prune -af   drops the entire cache.
 *   image prune -af     drops unused images, not just dangling ones, so base images
 *                       (python:3.10-slim and friends) go too. They re-pull in seconds.
 *   container prune -f  drops stopped containers, which pin the layers of images the
 *                       image prune above would otherwise refuse to touch.
 *
 * WHY until=24h on the aggressive steps, and why it is not optional:
 * static-build and backend-build are separate BullMQ queues in one process, so a static build
 * can be mid-flight while a backend build runs this. `docker pull` then createContainer is not
 * atomic; without the filter, an aggressive prune landing in that window would delete the image
 * the other build just pulled and is about to start. The filter makes us ignore anything
 * touched recently, which is exactly the set an in-flight build cares about.
 *
 * WHY NOT `docker system prune -f`:
 * it is `container prune` with no filter, so it deletes EVERY stopped container on the host.
 * Our compose services (app, redis, caddy) share this daemon. Stop redis for maintenance, let a
 * build finish, and its cleanup deletes the container. Named volumes survive and compose can
 * recreate it, but that is not a surprise a deploy should be able to spring on you.
 *
 * Known tradeoff of container prune even with the filter: a compose service that has been
 * stopped for over 24h will be removed. Acceptable for us; if that changes, drop the command.
 */
export const reclaimDockerDisk = async (deploymentId: string, mode: "routine" | "aggressive" = "routine") => {
    const commands: string[][] =
        mode === "aggressive"
            ? [
                ["builder", "prune", "-af"],
                ["image", "prune", "-af", "--filter", "until=24h"],
                ["container", "prune", "-f", "--filter", "until=24h"],
            ]
            : [
                ["image", "prune", "-f"],
                ["builder", "prune", "-f", `--keep-storage=${BUILD_CACHE_KEEP_MB * MB}`],
            ];

    for (const args of commands) {
        let result = await runDocker(args);

        // --keep-storage is deprecated in favour of --max-used-space in recent Docker, and the
        // daemon version here is whatever the host has. Rather than sniff `docker version`,
        // retry uncapped on rejection: losing the cap is much better than losing the prune.
        if (!result.ok && args.includes("builder") && args.some(a => a.startsWith("--keep-storage"))) {
            result = await runDocker(["builder", "prune", "-f"]);
        }

        if (!result.ok) {
            await workerLog(deploymentId, `Cleanup step "docker ${args.join(" ")}" failed: ${result.output}`, "stderr");
            continue;
        }

        const summary = reclaimedLine(result.output);
        if (summary) await workerLog(deploymentId, `Cleanup: docker ${args[0]} prune -> ${summary}`);
    }
};

/**
 * Preflight gate. Call before the clone, once the deployment row exists so the logs have
 * somewhere to go.
 *
 * THROWS when the host cannot host the build. That is the point: the caller's catch marks the
 * deployment FAILED and writes error.message into the deployment log, so the user gets numbers
 * and an action within seconds instead of a 13-minute compile ending in a linker error they
 * cannot interpret.
 *
 * MIN_FREE_DISK_MB is a floor for the whole build, not a measured requirement — we cannot know
 * what a repo needs before building it. 6 GB default is sized for the case that broke us (a
 * ~775 MB apt layer plus dlib's object files and LTO intermediates). Tune per host.
 *
 * Inherently racy: two builds can pass the check and then compete for the same space. Worker
 * concurrency is 1 per queue, so at most one static and one backend build overlap, which the
 * floor absorbs. Raise the floor before raising concurrency.
 */
export const ensureDiskSpaceForBuild = async (deploymentId: string, buildPath: string) => {
    const required = MIN_FREE_DISK_MB * MB;
    const free = await getFreeDiskBytes(buildPath);

    if (free === null) {
        await workerLog(deploymentId, `Could not read free disk space for ${buildPath}. Skipping the disk preflight check.`, "stderr");
        return;
    }

    if (free >= required) {
        await workerLog(deploymentId, `Disk preflight OK: ${formatBytes(free)} free on the build host (minimum ${formatBytes(required)}).`);
        return;
    }

    // Under the floor is not fatal yet: most of the time the shortfall is our own accumulated
    // cache. Try to earn the space back before refusing someone's deploy.
    await workerLog(
        deploymentId,
        `Low disk space on the build host: ${formatBytes(free)} free, ${formatBytes(required)} required. Reclaiming Docker disk before starting...`,
        "stderr"
    );
    await reclaimDockerDisk(deploymentId, "aggressive");

    const freeAfter = (await getFreeDiskBytes(buildPath)) ?? 0;

    if (freeAfter >= required) {
        await workerLog(deploymentId, `Recovered ${formatBytes(freeAfter - free)}. Now ${formatBytes(freeAfter)} free, continuing with the build.`);
        return;
    }

    // Still short after pruning everything we own, so the space is held by something outside
    // Docker (old clones, logs, an undersized volume). Nothing left to do automatically — say
    // so plainly, because this message is what the user reads in the dashboard.
    throw new Error(
        `Not enough disk space on the build host to start this build. ` +
        `Free: ${formatBytes(freeAfter)}, required: ${formatBytes(required)}. ` +
        `Docker images and build caches were already pruned, so the host itself is out of room. ` +
        `Free up space or grow the disk and redeploy (threshold is configurable via MIN_FREE_DISK_MB).`
    );
};

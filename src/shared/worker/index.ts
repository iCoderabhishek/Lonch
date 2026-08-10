import { staticDeployWorker } from "./static-build-job";
import { backendDeployWorker } from "./backend-build-job";
import { teardownWorker } from "./teardown-job";

console.log(" Worker process started. Listening for jobs...");

const shutdown = async () => {
    console.log("Shutting down workers...");
    await staticDeployWorker.close();
    await backendDeployWorker.close();
    await teardownWorker.close();
    process.exit(0);
};


// NOTEs - 
// process.on('SIGTERM', callback) and process.on('SIGINT', callback) are used to close the workers cleanly when the application is shutting down.
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

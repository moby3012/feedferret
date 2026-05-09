export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    const { startBackgroundSync } = await import("./lib/background-sync");
    startBackgroundSync();
}

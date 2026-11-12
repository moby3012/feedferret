/** Host queues keep spacing waits outside worker slots and rotate ready hosts fairly. */
export async function drainHostQueues<T extends { url: string }, R>(
    items: readonly T[],
    options: {
        concurrency: number;
        deadline: number;
        /** retryAfterMs: retry this item later in the run; pauseMs: item done, but its host asked us to back off. */
        run: (item: T) => Promise<{ result: R; retryAfterMs?: number; pauseMs?: number }>;
        spacingRemaining: (url: string) => number;
        spacingMs: number;
        defer: (item: T, waitMs: number) => Promise<R>;
    },
): Promise<R[]> {
    type Entry = { item: T; index: number };
    type Lane = { entries: Entry[]; readyAt: number; active: boolean };
    const grouped = new Map<string, Lane>();
    items.forEach((item, index) => {
        let host: string;
        try { host = new URL(item.url).hostname.toLowerCase(); } catch { host = item.url; }
        let lane = grouped.get(host);
        if (!lane) { lane = { entries: [], readyAt: 0, active: false }; grouped.set(host, lane); }
        lane.entries.push({ item, index });
    });
    const lanes = [...grouped.values()];
    const results = new Array<R>(items.length);
    const running = new Set<Promise<void>>();
    let cursor = 0;
    let failure: unknown;
    while (lanes.some(lane => lane.entries.length) || running.size) {
        const now = Date.now();
        if (now < options.deadline && !failure) {
            for (let scanned = 0; scanned < lanes.length && running.size < options.concurrency; scanned++) {
                const lane = lanes[cursor];
                cursor = (cursor + 1) % lanes.length;
                if (lane.active || !lane.entries.length || lane.readyAt > now) continue;
                const entry = lane.entries[0];
                lane.active = true;
                const task = Promise.resolve().then(() => options.run(entry.item)).then(({ result, retryAfterMs, pauseMs }) => {
                    if (retryAfterMs !== undefined) {
                        // A different background run owns this host: retry the same feed later in this pass.
                        lane.readyAt = Date.now() + Math.max(1, retryAfterMs);
                    } else {
                        results[entry.index] = result;
                        lane.entries.shift();
                        lane.readyAt = Date.now() + Math.max(options.spacingRemaining(entry.item.url), pauseMs ?? 0);
                    }
                }).catch(error => { failure = error; }).finally(() => {
                    lane.active = false;
                    running.delete(task);
                });
                running.add(task);
            }
        }
        if (failure || Date.now() >= options.deadline) {
            await Promise.all(running);
            break;
        }
        const readyTimes = lanes.filter(lane => !lane.active && lane.entries.length).map(lane => lane.readyAt);
        const next = Math.min(...readyTimes);
        // No useful retry before the deadline: persist leftovers immediately, rather than wait out a quota.
        if (!running.size && next >= options.deadline) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waits: Promise<unknown>[] = [...running];
        if (running.size < options.concurrency && Number.isFinite(next)) {
            waits.push(new Promise(resolve => { timer = setTimeout(resolve, Math.max(1, Math.min(next, options.deadline) - Date.now())); }));
        }
        if (!waits.length) break;
        await Promise.race(waits);
        if (timer) clearTimeout(timer);
    }
    if (failure) throw failure;
    for (const lane of lanes) {
        for (const [offset, entry] of lane.entries.entries()) {
            results[entry.index] = await options.defer(entry.item, Math.max(1, lane.readyAt - Date.now()) + offset * options.spacingMs);
        }
    }
    return results;
}

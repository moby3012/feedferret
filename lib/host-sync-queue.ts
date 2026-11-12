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
        /** Leftovers when the budget ends; waitMs is when this host's lane (plus its queue position) frees up. */
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
    let lanes = [...grouped.values()];
    const results = new Array<R>(items.length);
    const running = new Set<Promise<void>>();
    let cursor = 0;
    let failure: unknown;
    while (lanes.length || running.size) {
        const now = Date.now();
        if (now < options.deadline && !failure) {
            for (let scanned = 0; scanned < lanes.length && running.size < options.concurrency; scanned++) {
                cursor %= lanes.length;
                const lane = lanes[cursor++];
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
        // Drained hosts leave the rotation.
        lanes = lanes.filter(lane => lane.active || lane.entries.length);
        const next = lanes.reduce((min, lane) => lane.active ? min : Math.min(min, lane.readyAt), Infinity);
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
    const leftovers = lanes.flatMap(lane => lane.entries.map((entry, offset) => ({ entry, waitMs: Math.max(1, lane.readyAt - Date.now()) + offset * options.spacingMs })));
    for (let start = 0; start < leftovers.length; start += 20) {
        await Promise.all(leftovers.slice(start, start + 20).map(async ({ entry, waitMs }) => {
            results[entry.index] = await options.defer(entry.item, waitMs);
        }));
    }
    return results;
}

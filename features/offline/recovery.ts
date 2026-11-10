// After the UI fell back to the offline store while the browser still reports "online" (server down,
// proxy 502, lie-fi) no `online` event will ever announce the recovery. This probe asks the server
// periodically (backoff) and tells the caller when it answers again.

/** 3 s, then slower; the last delay repeats. */
export const PROBE_DELAYS_MS = [3000, 6000, 12_000, 30_000, 60_000];

export interface RecoveryProbeDeps {
  /** true = the server answered (any answer), false = still unreachable. */
  probe(): Promise<boolean>;
  onRecovered(): void;
  delays?: readonly number[];
}

export interface RecoveryProbe {
  /** Idempotent: a running probe keeps its backoff position. */
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export function createRecoveryProbe({ probe, onRecovered, delays = PROBE_DELAYS_MS }: RecoveryProbeDeps): RecoveryProbe {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let step = 0;

  const schedule = () => {
    timer = setTimeout(async () => {
      timer = undefined;
      let reachable = false;
      try {
        reachable = await probe();
      } catch {
        reachable = false;
      }
      if (!running) return; // stopped while the probe was in flight
      if (reachable) {
        running = false;
        step = 0;
        onRecovered();
        return;
      }
      step = Math.min(step + 1, delays.length - 1);
      schedule();
    }, delays[step]);
  };

  return {
    start() {
      if (running) return;
      running = true;
      step = 0;
      schedule();
    },
    stop() {
      running = false;
      step = 0;
      clearTimeout(timer);
      timer = undefined;
    },
    get running() {
      return running;
    },
  };
}

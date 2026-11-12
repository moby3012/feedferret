const HOUR = 60 * 60 * 1000;
const DEFAULT_BUDGET = 500 * 1024 * 1024;
function byteBudget() {
  const value = Number(process.env.FEEDFERRET_MEDIA_USER_BYTES_PER_HOUR);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_BUDGET;
}

/** Per-process, bounded accounting. Bytes include sniffing and rejected bodies. */
export class MediaTransferLimiter {
  private active = 0;
  private hosts = new Map<string, number>();
  private users = new Map<string, { active: number; bytes: number; resetAt: number }>();
  constructor(private budget = byteBudget, private globalCap = 32, private userCap = 6, private hostCap = 4) {}

  acquire(userId: string, hostname = ""): { status: 429 | 503 } | { charge: (bytes: number) => boolean; moveHost: (hostname: string) => boolean; release: () => void } {
    const now = Date.now();
    for (const [id, entry] of this.users) {
      if (entry.resetAt <= now && entry.active === 0) this.users.delete(id);
    }
    let entry = this.users.get(userId);
    if (!entry) {
      if (this.users.size >= 10_000) return { status: 503 };
      entry = { active: 0, bytes: 0, resetAt: now + HOUR };
      this.users.set(userId, entry);
    }
    if (entry.resetAt <= now) { entry.bytes = 0; entry.resetAt = now + HOUR; }
    if (entry.bytes >= this.budget() || entry.active >= this.userCap) return { status: 429 };
    if (this.active >= this.globalCap) return { status: 503 };
    const normalize = (host: string) => host.toLowerCase().replace(/\.$/, "");
    let host = normalize(hostname);
    if ((this.hosts.get(host) ?? 0) >= this.hostCap) return { status: 503 };
    const releaseHost = () => {
      const count = (this.hosts.get(host) ?? 1) - 1;
      if (count) this.hosts.set(host, count);
      else this.hosts.delete(host);
    };
    this.hosts.set(host, (this.hosts.get(host) ?? 0) + 1);
    entry.active++;
    this.active++;
    let released = false;
    return {
      moveHost: hostname => {
        const next = normalize(hostname);
        if (next === host) return true;
        if (released || (this.hosts.get(next) ?? 0) >= this.hostCap) return false;
        releaseHost();
        host = next;
        this.hosts.set(host, (this.hosts.get(host) ?? 0) + 1);
        return true;
      },
      charge: bytes => {
        if (entry.resetAt <= Date.now()) { entry.bytes = 0; entry.resetAt = Date.now() + HOUR; }
        entry.bytes += bytes;
        return entry.bytes <= this.budget();
      },
      release: () => {
        if (released) return;
        released = true;
        releaseHost();
        entry.active--;
        this.active--;
      },
    };
  }
}
export const mediaTransfers = new MediaTransferLimiter();

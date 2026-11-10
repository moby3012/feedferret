/**
 * Copies only the allowed keys from untrusted input. Server actions receive
 * arbitrary client JSON at runtime — their TypeScript parameter types are not
 * enforced — so never spread `data` into a Prisma `update`.
 */
export function pickFields<T extends object, K extends keyof T & string>(input: T, allowed: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  if (!input || typeof input !== "object") return out;
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

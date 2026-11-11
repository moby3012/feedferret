// Encrypt-on-write for every secret column (security audit #2, M8 PR 5).
//
// A Prisma query extension on the app's client: every create / update /
// upsert / *Many write that sets a column from the SECRET_COLUMNS registry
// stores it v2-sealed (`ff2.`, current key, purpose as AAD). Writers may pass
// plaintext (feed auth, notification tokens, TOTP seeds, webhook JSON …) or an
// already-sealed value (kept as-is), so no write path can store a secret in
// the clear by forgetting to call `sealSecret`. Readers go through
// lib/secret-box.ts and accept every format.
//
// OAuth Account tokens (`@auth/prisma-adapter`) are never used by the app and
// are dropped on write instead of being stored.
import { SECRET_COLUMNS, sealForColumn } from "./secret-box-core.mjs";
import { getKeyring } from "./secret-box";

type Column = (typeof SECRET_COLUMNS)[number];

const BY_MODEL = new Map<string, Column[]>();
for (const column of SECRET_COLUMNS) {
  const model = column.model[0].toUpperCase() + column.model.slice(1);
  BY_MODEL.set(model, [...(BY_MODEL.get(model) ?? []), column]);
}

const OAUTH_TOKEN_FIELDS = ["access_token", "refresh_token", "id_token"] as const;

const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);

type Data = Record<string, unknown>;

function sealData(columns: Column[], data: Data): Data {
  let out: Data | null = null;
  for (const column of columns) {
    if (!(column.column in data)) continue;
    const value = data[column.column];
    let sealed: unknown = value;
    if (typeof value === "string") {
      sealed = sealForColumn(column, value, getKeyring());
    } else if (value && typeof value === "object" && typeof (value as { set?: unknown }).set === "string") {
      const next = sealForColumn(column, (value as { set: string }).set, getKeyring());
      if (next !== (value as { set: string }).set) sealed = { set: next };
    }
    if (sealed !== value) (out ??= { ...data })[column.column] = sealed;
  }
  return out ?? data;
}

function dropOAuthTokens(data: Data): Data {
  if (!OAUTH_TOKEN_FIELDS.some((field) => data[field] != null)) return data;
  const out = { ...data };
  for (const field of OAUTH_TOKEN_FIELDS) if (field in out) out[field] = null;
  return out;
}

/** Map every data object of a write's arguments (top level; secret columns are never written through nested relation writes). */
function mapData(operation: string, args: Record<string, unknown>, fn: (data: Data) => Data): Record<string, unknown> {
  const map = (value: unknown) => {
    if (Array.isArray(value)) return value.map((item) => (item && typeof item === "object" ? fn(item as Data) : item));
    return value && typeof value === "object" ? fn(value as Data) : value;
  };
  if (operation === "upsert") return { ...args, create: map(args.create), update: map(args.update) };
  return "data" in args ? { ...args, data: map(args.data) } : args;
}

/**
 * Returns the write's arguments with every secret column sealed (the caller's
 * objects are never mutated). Exported for tests and for clients built
 * outside lib/db.ts.
 */
export function sealWriteArgs<A>(model: string, operation: string, args: A): A {
  if (!WRITE_OPERATIONS.has(operation) || !args || typeof args !== "object") return args;
  if (model === "Account") return mapData(operation, args as Record<string, unknown>, dropOAuthTokens) as A;
  const columns = BY_MODEL.get(model);
  if (!columns) return args;
  return mapData(operation, args as Record<string, unknown>, (data) => sealData(columns, data)) as A;
}

type Extendable = {
  $extends: (extension: {
    query: {
      $allModels: {
        $allOperations: (params: { model: string; operation: string; args: unknown; query: (args: unknown) => Promise<unknown> }) => Promise<unknown>;
      };
    };
  }) => unknown;
};

export function withSecretSealing<T>(client: T): T {
  return (client as unknown as Extendable).$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return query(sealWriteArgs(model, operation, args));
        },
      },
    },
  }) as T;
}

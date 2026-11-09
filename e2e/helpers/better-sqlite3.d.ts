// Minimal typing: better-sqlite3 ships no types and we avoid a new devDependency
// (and lockfile change) for the handful of calls the E2E helpers make.
declare module "better-sqlite3" {
  interface Statement {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export default class Database {
    constructor(path: string);
    pragma(source: string): unknown;
    prepare(sql: string): Statement;
    close(): void;
  }
}

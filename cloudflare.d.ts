interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
interface D1Database {
  exec(query: string): Promise<unknown>;
  prepare(query: string): D1PreparedStatement;
}
interface Fetcher {
  fetch(request: Request): Promise<Response>;
}
declare module "cloudflare:workers" {
  export const env: { DB: D1Database; [key: string]: unknown };
}

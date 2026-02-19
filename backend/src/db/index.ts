import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config";

const client = postgres(config.databaseUrl, {
  max: 10,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 15,
});

export const db = drizzle(client);

export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FileMigrationProvider, Migrator } from "kysely";
import { loadConfig } from "./config";
import { createDatabase } from "./db";

async function main() {
  const config = loadConfig();
  const db = createDatabase(config);

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const migrationFolder = path.join(__dirname, "migrations");

    const migrator = new Migrator({
      db,
      provider: new FileMigrationProvider({ fs, path, migrationFolder }),
    });

    const { error, results } = await migrator.migrateToLatest();

    for (const result of results ?? []) {
      if (result.status === "Success") {
        console.log(`[migration] ${result.migrationName} completed`);
      } else if (result.status === "Error") {
        console.error(`[migration] ${result.migrationName} failed`, result.error);
      }
    }

    if (error) {
      console.error("Migration failed", error);
      process.exitCode = 1;
    } else {
      console.log("All migrations ran successfully");
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error("Migration command failed", err);
  process.exitCode = 1;
});

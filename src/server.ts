import { createApp } from "./app";
import { loadConfig } from "./config";
import { createDatabase } from "./db";
import { createS3Client } from "./lib/s3";

async function bootstrap() {
  const config = loadConfig();
  const db = createDatabase(config);
  const s3Client = createS3Client(config.s3);

  const app = createApp({ config, db, s3Client });
  const port = config.port;

  const server = app.listen(port, () => {
    console.log(`API on http://localhost:${port}`);
  });

  const shutdown = async () => {
    server.close();
    await db.destroy();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

bootstrap().catch((err) => {
  console.error("Failed to start server", err);
  process.exit(1);
});

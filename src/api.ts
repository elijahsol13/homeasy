import { createContainer } from './container';
import { runMigrations } from './database/migrate';
import { startApiServer } from './modules/api/server';

async function main(): Promise<void> {
  const container = createContainer();

  // Ensure DB schema is up to date
  runMigrations(container.db);

  await startApiServer(container);
}

main().catch((err) => {
  console.error('Fatal error starting HomEasy API:', err);
  process.exit(1);
});


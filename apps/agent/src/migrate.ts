import { loadConfig } from './config';
import { databaseName, runMigrations } from './db/client';

const config = loadConfig();
await runMigrations(config.databaseUrl);
console.log(`migrations applied to ${databaseName(config.databaseUrl)}`);

// Standalone migration entrypoint: `npm run init-db`
import { getDb } from './index.js';

const db = getDb();
console.log('Database migrated at', db.name);
db.close();

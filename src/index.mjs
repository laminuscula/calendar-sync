import { runSync } from './sync-core.mjs';
import cron from 'node-cron';

runSync().catch(console.error);

cron.schedule('0 */3 * * *', () => {
  console.log(new Date().toISOString());
  runSync().catch(console.error);
});
import 'dotenv/config';
import { runScraper } from './scraper';

if (process.env.HOMEASY_DEPLOYMENT_ROLE !== 'vps') {
  throw new Error('VPS Khmer24 worker requires HOMEASY_DEPLOYMENT_ROLE=vps');
}

void runScraper({ skipFacebook: true }).catch((error: unknown) => {
  console.error('VPS Khmer24 worker failed:', error);
  process.exitCode = 1;
});

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      slug: { type: 'string' },
    },
    allowPositionals: false,
  });

  if (!values.slug) {
    console.error('❌ Usage: npm run tracking:inspect -- --slug <slug>');
    process.exit(1);
  }

  const container = createContainer();
  runMigrations(container.db);

  const link = container.trackedLinksRepo.findBySlug(values.slug);
  if (!link) {
    console.error(`❌ Tracking link "${values.slug}" not found`);
    process.exit(1);
  }

  const clicks = container.analyticsRepo.countEvents('tracking_link_clicked', { slug: link.slug });
  const opens = container.analyticsRepo.countEvents('miniapp_opened', { slug: link.slug });

  const events = container.analyticsRepo.listEvents({
    eventTypeIn: ['tracking_link_clicked', 'miniapp_opened'],
    metadataFilter: { slug: link.slug },
    limit: 100,
  });

  console.log('\nLink:');
  console.log(JSON.stringify(link, null, 2));
  console.log(`\nClicks: ${clicks}`);
  console.log(`Opens:  ${opens}\n`);
  console.log('Events:');
  if (events.length === 0) {
    console.log('  (none)');
  } else {
    for (const event of events) {
      const ts = event.created_at;
      const meta = JSON.parse(event.metadata);
      const telegramId = meta.telegram_id ?? event.telegram_id ?? '-';
      console.log(`  ${ts}  ${event.event_type.padEnd(22)} telegram_id=${telegramId}`);
    }
  }
  console.log('');
}

main().catch((err: unknown) => {
  console.error('❌ Failed to inspect tracking link:', err);
  process.exit(1);
});

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { TrackingLinkService } from '../src/services/tracking.service';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      campaign: { type: 'string' },
      'request-id': { type: 'string' },
      'group-id': { type: 'string' },
      'post-id': { type: 'string' },
      'listing-id': { type: 'string' },
      'agent-id': { type: 'string' },
      payload: { type: 'string' },
      kind: { type: 'string', default: 'miniapp' },
    },
    allowPositionals: false,
  });

  if (values.kind !== 'miniapp' && values.kind !== 'url') {
    console.error('❌ --kind must be "miniapp" or "url"');
    process.exit(1);
  }

  const container = createContainer();
  runMigrations(container.db);

  const service = new TrackingLinkService(container);
  const result = service.createLink({
    kind: values.kind,
    payload: values.payload,
    source: values.source ?? null,
    campaign: values.campaign ?? null,
    requestId: values['request-id'] ?? null,
    groupId: values['group-id'] ?? null,
    postId: values['post-id'] ?? null,
    listingId: values['listing-id'] ? Number(values['listing-id']) : null,
    agentId: values['agent-id'] ? Number(values['agent-id']) : null,
  });

  console.log(`\nSlug:       ${result.link.slug}`);
  console.log(`Tracking:   ${result.publicUrl}`);
  console.log(`Telegram:   ${result.telegramDeepLink}\n`);
  console.log('Attribution:');
  console.log(JSON.stringify(service.resolveAttribution(result.link), null, 2));
}

main().catch((err: unknown) => {
  console.error('❌ Failed to mint tracking link:', err);
  process.exit(1);
});

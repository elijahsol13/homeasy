import { env } from '../config/env';
import type { AppContainer } from '../container';
import type {
  CreateTrackedLinkInput,
  TrackedLink,
} from '../database/repositories/tracked-links.repo';

export interface TrackingAttribution {
  source: string | null;
  campaign: string | null;
  group_id: string | null;
  post_id: string | null;
  request_id: string | null;
  listing_id: number | null;
  listing_public_ref: string | null;
  agent_id: number | null;
}

export interface CreateLinkResult {
  link: TrackedLink;
  publicUrl: string;
  telegramDeepLink: string;
}

export class TrackingLinkService {
  constructor(private readonly container: AppContainer) {}

  createLink(input: CreateTrackedLinkInput): CreateLinkResult {
    let normalized=input;
    if(input.listingPublicRef){
      const identity=this.container.listingIdentityRepo.resolvePublicRef(input.listingPublicRef);
      if(!identity)throw new Error('Unknown canonical listing public_ref');
      normalized={...input,listingId:identity.listingId,listingPublicRef:identity.publicRef};
    }
    const link = this.container.trackedLinksRepo.createLink(normalized);
    return {
      link,
      publicUrl: this.buildTrackingUrl(link.slug),
      telegramDeepLink: this.buildTelegramDeepLink(link.slug),
    };
  }

  resolveAttribution(link: TrackedLink): TrackingAttribution {
    return {
      source: link.source,
      campaign: link.campaign,
      group_id: link.group_id,
      post_id: link.post_id,
      request_id: link.request_id,
      listing_id: link.listing_id,
      listing_public_ref: link.listing_public_ref ?? (link.listing_id===null?null:
        this.container.listingIdentityRepo.resolve('legacy_property_id',link.listing_id)?.publicRef??null),
      agent_id: link.agent_id,
    };
  }

  buildTrackingUrl(slug: string): string {
    const base = (env.TRACKING_PUBLIC_URL ?? env.API_PUBLIC_URL)?.replace(/\/$/, '') ?? '';
    return base ? `${base}/r/${slug}` : `/r/${slug}`;
  }

  buildTelegramDeepLink(slug: string): string {
    const base =
      env.TELEGRAM_MINIAPP_URL ||
      (env.TELEGRAM_BOT_USERNAME ? `https://t.me/${env.TELEGRAM_BOT_USERNAME.replace(/^@/, '')}` : undefined);
    if (!base || !base.startsWith('https://t.me/')) {
      throw new Error('TELEGRAM_MINIAPP_URL or TELEGRAM_BOT_USERNAME is required to build a Telegram deep link');
    }
    return `${base}?startapp=${encodeURIComponent(slug)}`;
  }
}

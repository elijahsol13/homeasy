import type { FastifyPluginAsync } from 'fastify';
import type { AppContainer } from '../../../container';
import { isAdminTelegramUser, requireTelegramAuth, optionalTelegramAuth } from '../auth';
import { TrackingLinkService } from '../../../services/tracking.service';
import type { TrackedLink } from '../../../database/repositories/tracked-links.repo';
import { isCanonicalReadCanary } from '../listing-read-path';

/**
 * Domain tracking gateway (roadmap §1.5):
 *   GET /r/:slug  — records `tracking_link_clicked` with full attribution,
 *                   then 302-redirects into the Telegram Mini App deep link.
 *   POST /api/v1/links — admin-only link minting.
 */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function resolveTargetUrl(link: TrackedLink, service: TrackingLinkService): string | null {
  if (link.kind === 'url') {
    // Only allow http(s) targets — never javascript:/data: etc.
    const target = link.payload ?? '';
    return /^https?:\/\//i.test(target) ? target : null;
  }

  try {
    return service.buildTelegramDeepLink(link.slug);
  } catch {
    // Fallback: hosted web app URL (no Telegram context, but better than a dead end)
    return null;
  }
}

function renderLanding(link: TrackedLink, targetUrl: string | null): string {
  const button = targetUrl
    ? `<a class="btn" href="${escapeHtml(targetUrl)}">Open HomEasy in Telegram</a>
       <p class="hint">If nothing happened, tap the button above.</p>
       <script>setTimeout(function(){ window.location.href = ${JSON.stringify(targetUrl)}; }, 800);</script>`
    : `<p class="hint">This link is not configured yet. Please open the HomEasy bot in Telegram.</p>`;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>HomEasy</title>
<style>
  body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f4;color:#1c1917}
  .card{background:#fff;padding:32px 28px;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;max-width:340px}
  .btn{display:inline-block;margin-top:16px;padding:12px 24px;background:#2AABEE;color:#fff;text-decoration:none;border-radius:10px;font-weight:600}
  .hint{margin-top:16px;font-size:13px;color:#78716c}
  h1{font-size:20px;margin:0}
</style></head>
<body><div class="card"><h1>HomEasy</h1><p>Apartments for rent in Siem Reap</p>${button}</div></body></html>`;
}

export const trackingRoutes: FastifyPluginAsync<{ container: AppContainer }> = async (fastify, opts) => {
  const { container } = opts;
  const trackingService = new TrackingLinkService(container);

  fastify.get('/r/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const link = container.trackedLinksRepo.findBySlug(slug);

    if (!link) {
      return reply.status(404).type('text/html').send(
        '<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Link not found or expired</h2></body></html>',
      );
    }

    container.trackedLinksRepo.recordClick(link.id);
    try {
      container.analyticsRepo.trackEvent({
        eventType: 'tracking_link_clicked',
        metadata: {
          slug: link.slug,
          link_id: link.id,
          ...trackingService.resolveAttribution(link),
          agent_id: link.agent_id,
          ip: request.ip,
          ua: request.headers['user-agent'],
        },
      });
    } catch {
      // tracking must never break the redirect
    }

    const targetUrl = resolveTargetUrl(link, trackingService);
    if (targetUrl) {
      return reply.redirect(targetUrl, 302);
    }
    return reply.type('text/html').send(renderLanding(link, targetUrl));
  });

  // Mini App opens a tracked link. Resolves the slug to attribution server-side
  // and stores an event-level `miniapp_opened` record linked to the user identity.
  fastify.post(
    '/api/v1/links/:slug/opened',
    { preHandler: optionalTelegramAuth },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const link = container.trackedLinksRepo.findBySlug(slug);

      if (!link) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tracking link not found' });
      }

      // A canonical canary must not resolve a tracking link to a listing hidden by moderation.
      if (isCanonicalReadCanary(request.telegramUser?.id) && (link.listing_public_ref || link.listing_id !== null)) {
        const identity = link.listing_public_ref
          ? container.listingIdentityRepo.resolvePublicRef(link.listing_public_ref)
          : link.listing_id !== null
            ? container.listingIdentityRepo.resolve('legacy_property_id', link.listing_id)
            : undefined;
        const listing = identity ? container.canonicalListingRepo.getPropertyById(identity.listingId) : undefined;
        if (!listing) {
          request.log.info({ event: 'canonical_canary_tracking_resolution', servedPath: 'canonical', slug, resolved: false });
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Listing not found' });
        }
        request.log.info({ event: 'canonical_canary_tracking_resolution', servedPath: 'canonical', slug, publicRef: identity!.publicRef, resolved: true });
      }

      const body = (request.body ?? {}) as {
        telegram_user_id?: number;
        telegram_username?: string;
      };
      const telegramId = request.telegramUser?.id ?? body.telegram_user_id;
      const telegramUsername = request.telegramUser?.username ?? body.telegram_username ?? null;

      // Ensure a user record exists for analytics identity, but do not block the request.
      let userId: number | null = null;
      if (typeof telegramId === 'number' && !isNaN(telegramId)) {
        const existing = container.usersRepo.findByTelegramId(telegramId);
        if (existing) {
          userId = existing.id;
        }
      }

      try {
        container.analyticsRepo.trackEvent({
          userId: userId ?? undefined,
          telegramId: typeof telegramId === 'number' && !isNaN(telegramId) ? telegramId : null,
          eventType: 'miniapp_opened',
          metadata: {
            slug: link.slug,
            link_id: link.id,
            ...trackingService.resolveAttribution(link),
            agent_id: link.agent_id,
            telegram_username: telegramUsername,
            ip: request.ip,
            ua: request.headers['user-agent'],
          },
        });
      } catch {
        // tracking must never break the Mini App
      }

      return reply.send({
        ok: true,
        slug: link.slug,
        attribution: trackingService.resolveAttribution(link),
      });
    },
  );

  fastify.post(
    '/api/v1/links',
    { preHandler: requireTelegramAuth },
    async (request, reply) => {
      const isAdminUser =
        isAdminTelegramUser(request.telegramUser?.id) ||
        (request.telegramUser
          ? container.usersRepo.findByTelegramId(request.telegramUser.id)?.role === 'admin'
          : false);

      if (!isAdminUser) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Admin access required',
        });
      }

      const body = (request.body ?? {}) as {
        kind?: 'miniapp' | 'url';
        payload?: string;
        source?: string;
        campaign?: string;
        groupId?: string;
        postId?: string;
        requestId?: string;
        listingId?: number;
        listingPublicRef?: string;
        agentId?: number;
        metadata?: Record<string, unknown>;
      };

      if (body.kind === 'url' && !/^https?:\/\//i.test(body.payload ?? '')) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'kind=url requires an http(s) payload',
        });
      }

      const result = trackingService.createLink(body);
      return reply.send({
        ok: true,
        slug: result.link.slug,
        url: result.publicUrl,
        link: result.link,
      });
    },
  );
};

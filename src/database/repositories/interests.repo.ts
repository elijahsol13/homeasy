import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface InterestFlow {
  interestId: string;
  requestId: string;
  offerId: string;
  contactGrantId: string;
  interestCreated: boolean;
  contactGrantCreated: boolean;
}

export class InterestsRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Creates the whole first-party conversion chain once per user and canonical
   * listing. A duplicate tap returns the original chain without creating a
   * second Request, Offer, or ContactGrant.
   */
  createOrGetFlow(input: {
    userId: number;
    listingId: number;
    searchContext: Record<string, unknown>;
  }): InterestFlow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existingInterest = this.db.prepare(
        'SELECT id FROM listing_interests WHERE user_id=? AND listing_id=?',
      ).get(input.userId, input.listingId) as { id: string } | undefined;
      const interestCreated = !existingInterest;
      const interestId = existingInterest?.id ?? this.id('int');

      if (!existingInterest) {
        this.db.prepare(`INSERT INTO listing_interests(id,user_id,listing_id,search_context_json)
          VALUES(?,?,?,?)`).run(interestId, input.userId, input.listingId, JSON.stringify(input.searchContext));
      } else {
        this.db.prepare("UPDATE listing_interests SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?")
          .run(interestId);
      }

      let request = this.db.prepare(
        'SELECT id FROM interest_requests WHERE interest_id=?',
      ).get(interestId) as { id: string } | undefined;
      if (!request) {
        const requestId = this.id('req');
        this.db.prepare(`INSERT INTO interest_requests(id,interest_id,user_id,listing_id)
          VALUES(?,?,?,?)`).run(requestId, interestId, input.userId, input.listingId);
        request = { id: requestId };
      }

      let offer = this.db.prepare(
        'SELECT id FROM listing_offers WHERE request_id=? AND listing_id=?',
      ).get(request.id, input.listingId) as { id: string } | undefined;
      if (!offer) {
        const offerId = this.id('off');
        this.db.prepare('INSERT INTO listing_offers(id,request_id,listing_id) VALUES(?,?,?)')
          .run(offerId, request.id, input.listingId);
        offer = { id: offerId };
      }

      let grant = this.db.prepare(
        'SELECT id FROM contact_grants WHERE user_id=? AND listing_id=?',
      ).get(input.userId, input.listingId) as { id: string } | undefined;
      const contactGrantCreated = !grant;
      if (!grant) {
        const grantId = this.id('cgr');
        this.db.prepare('INSERT INTO contact_grants(id,user_id,listing_id,offer_id) VALUES(?,?,?,?)')
          .run(grantId, input.userId, input.listingId, offer.id);
        grant = { id: grantId };
      }

      this.db.exec('COMMIT');
      return {
        interestId,
        requestId: request.id,
        offerId: offer.id,
        contactGrantId: grant.id,
        interestCreated,
        contactGrantCreated,
      };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction was not opened */ }
      throw error;
    }
  }

  private id(prefix: 'int' | 'req' | 'off' | 'cgr'): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
  }
}

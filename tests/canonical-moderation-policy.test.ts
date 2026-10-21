import { evaluateModerationCandidate } from '../src/modules/parser/canonical-moderation-policy';

const base: Parameters<typeof evaluateModerationCandidate>[0] = {
  id: 1, status: 'active', availability_status: 'available', title: '2BR apartment for rent',
  description: 'Rental', price: 35000, bedrooms: 2, bathrooms: null, city: 'siem_reap', category: 'apartment',
  property_type: 'Apartment', review_reason: null, source_type: 'KHMER24',
  source_url: 'https://www.khmer24.com/en/post-adid-12345',
  raw_text: 'Apartment for rent in Siem Reap. 2 bedrooms. Rent $350/month. Near Pub Street, 5 minutes away.',
  raw_payload_json: JSON.stringify({ listing: { price: 350, city: 'siem_reap', type: 'rent' } }),
  current_count: 1, conflicting_url: 0, legacy_aliases: 0,
  original_published_at: new Date().toISOString(), first_source_seen_at: new Date().toISOString(),
  matching_active_listings: 0,
};

describe('automated canonical moderation', () => {
  it('approves a source-corroborated fresh rental and ignores promotional travel-time claims', () => {
    expect(evaluateModerationCandidate(base)).toEqual({ approved: true, reasons: [] });
  });

  it('keeps explicit unsupported AI decisions out of automatic approval', () => {
    const payloads = [
      { listing: { price: 350, city: 'siem_reap', type: 'rent', is_real_estate: false } },
      { listing: { price: 350, city: 'siem_reap', type: 'rent' },
        listingExtraction: { is_supported_listing: false } },
      { listing: { price: 350, city: 'siem_reap', type: 'rent',
        listing_facts_json: JSON.stringify({ is_supported_listing: false }) } },
    ];
    for (const payload of payloads) {
      const result = evaluateModerationCandidate({ ...base, raw_payload_json: JSON.stringify(payload) });
      expect(result.approved).toBe(false);
      expect(result.reasons).toContain('AI_CLASSIFIED_UNSUPPORTED');
    }
  });

  it('does not count electricity or water tariffs as contradictory monthly rent', () => {
    const raw_text = 'Apartment for rent in Siem Reap, Svay Dangkum. 2 bedrooms. Rent $300/month.\n'
      + 'Electricity Price: 0.25$/KWh.\nWater Supply: $80/Month (Person).';
    const row = { ...base, price: 30000, raw_text,
      raw_payload_json: JSON.stringify({ listing: { price: 300, city: 'siem_reap', type: 'rent' } }),
    };

    expect(evaluateModerationCandidate(row)).toEqual({ approved: true, reasons: [] });
  });

  it('holds conflicting monthly prices, even when the structured price matches one', () => {
    const result = evaluateModerationCandidate({ ...base, raw_text: `${base.raw_text}\nRoom price 100/month` });
    expect(result.approved).toBe(false);
    expect(result.reasons).toContain('CONTRADICTORY_MONTHLY_PRICES');
  });

  it('holds when Khmer24 JSON-LD and the original body disagree on the rent', () => {
    const result = evaluateModerationCandidate({ ...base, price: 22000,
      raw_text: 'Apartment for rent in Siem Reap, Svay Dangkum. 2 bedrooms. Rent $220/month.',
      raw_payload_json: JSON.stringify({ listing: {
        source_title: 'Siem Reap, Apartment for rent', price: 250, city: 'siem_reap', type: 'rent',
        source_price: 250, source_price_currency: 'USD', source_price_origin: 'khmer24_json_ld_offer',
      } }),
    });
    expect(result.approved).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'CONTRADICTORY_STRUCTURED_SOURCE_PRICE', 'STRUCTURED_PRICE_MISMATCH',
    ]));
  });

  it('holds a real mixed rent/sale offer even when the sale is near the end of the original', () => {
    const result = evaluateModerationCandidate({ ...base, price: 150000,
      raw_text: 'Modern villa for rent in Siem Reap. '.repeat(15) +
        'Price: $1,500/month (Rent) & $450,000 (Sale)',
      raw_payload_json: JSON.stringify({ listing: { price: 1500, type: 'rent', city: 'siem_reap' } }),
    });
    expect(result.reasons).toContain('MIXED_OR_SALE_OFFER');
  });

  it('ignores a Khmer shop selling goods used solely as an agency-office landmark', () => {
    const result = evaluateModerationCandidate({ ...base,
      raw_text: 'Villa for rent in Siem Reap. Rent $350/month. 2 Bedrooms, 3 Bathrooms. ' +
        'Office location: opposite ហាងលក់សម្ភារៈកូនក្មេង.',
      bathrooms: 3,
    });
    expect(result).toEqual({ approved: true, reasons: [] });
  });

  it('holds an explicit Khmer sale offer while permitting incidental Khmer selling language', () => {
    const result = evaluateModerationCandidate({ ...base,
      raw_text: 'ផ្ទះសម្រាប់លក់ និងជួល នៅក្រុងសៀមរាប។ Rent $350/month.',
    });
    expect(result.reasons).toContain('MIXED_OR_SALE_OFFER');
  });

  it('recognizes the Khmer property-sale word order ផ្ទះលក់', () => {
    const result = evaluateModerationCandidate({ ...base,
      raw_text: 'Siem Reap villa for rent. Rent $350/month. ផ្ទះលក់',
    });
    expect(result.reasons).toContain('MIXED_OR_SALE_OFFER');
  });

  it('recognizes a comma-separated USD monthly amount as a single price', () => {
    const result = evaluateModerationCandidate({ ...base, price: 125000, bedrooms: null, title: 'Apartment for rent',
      raw_text: 'Apartment for rent in Siem Reap. Rent $1,250/month.',
      raw_payload_json: JSON.stringify({ listing: { price: 1250, city: 'siem_reap' } }),
    });
    expect(result).toEqual({ approved: true, reasons: [] });
  });

  it('recognizes monthly rent in Khmer with a dollar sign immediately before ខែ', () => {
    const row = { ...base, source_type: 'FACEBOOK_GROUP',
      raw_text: 'House for rent in Siemreap តម្លៃ $350$ខែ. 2 bedrooms.' };
    expect(evaluateModerationCandidate(row)).toEqual({ approved: true, reasons: [] });
  });

  it.each([
    ['369USD/ Villa per month', 369],
    ['one month 300$', 300],
    ['មួយខែ300$', 300],
    ['ផ្ទះ​ជួល​មួយ\u200bខែ300$ចរចារ', 300],
  ])('corroborates explicit source rent syntax %s', (priceText, price) => {
    const row = { ...base, price: price * 100,
      raw_text: (base.raw_text ?? '').replace('Rent $350/month.', `Rent ${priceText}.`),
      raw_payload_json: JSON.stringify({ listing: { price, city: 'siem_reap', type: 'rent' } }),
    };
    expect(evaluateModerationCandidate(row)).toEqual({ approved: true, reasons: [] });
  });

  it('accepts corroborated Khmer24 rent metadata when the original body has no price', () => {
    const row = { ...base, raw_text: 'Apartment in Siem Reap with 2 bedrooms.',
      raw_payload_json: JSON.stringify({listing: {
        source_title: 'Apartment for Rent in Siem Reap', price: 350, type: 'rent', city: 'siem_reap',
        source_price: 350, source_price_currency: 'USD', source_price_origin: 'khmer24_json_ld_offer',
      }}),
    };
    expect(evaluateModerationCandidate(row)).toEqual({ approved: true, reasons: [] });
    for (const changed of [
      { source_price: undefined },
      { source_price: 375 },
      { source_price_currency: undefined },
      { source_price_currency: 'KHR' },
      { source_price_origin: undefined },
      { source_price_origin: 'khmer24_dom_header' },
    ]) {
      const listing = { source_title: 'Apartment for Rent in Siem Reap', price: 350, type: 'rent', city: 'siem_reap',
        source_price: 350, source_price_currency: 'USD', source_price_origin: 'khmer24_json_ld_offer', ...changed };
      expect(evaluateModerationCandidate({ ...row, raw_payload_json: JSON.stringify({ listing }) }).reasons)
        .toContain('MONTHLY_PRICE_NOT_CONFIRMED_BY_SOURCE');
    }
    expect(evaluateModerationCandidate({ ...row, source_type: 'FACEBOOK_GROUP' }).reasons)
      .toContain('MONTHLY_PRICE_NOT_CONFIRMED_BY_SOURCE');
    expect(evaluateModerationCandidate({ ...row, raw_text: `${row.raw_text}\nRent $350/month.`,
      raw_payload_json: JSON.stringify({listing: {source_title: 'Apartment for Rent in Siem Reap', price: 400, type: 'rent'}}),
    })).toEqual({ approved: true, reasons: [] });
    expect(evaluateModerationCandidate({ ...row, raw_text: 'Apartment for rent in Siem Reap.',
      raw_payload_json: JSON.stringify({listing: {source_title: 'Apartment for Rent in Siem Reap', price: 400, type: 'rent'}}),
    }).reasons).toEqual(expect.arrayContaining(['STRUCTURED_PRICE_MISMATCH', 'MONTHLY_PRICE_NOT_CONFIRMED_BY_SOURCE']));
    expect(evaluateModerationCandidate({ ...row,
      raw_payload_json: JSON.stringify({listing: {source_title: 'Apartment for Rent in Siem Reap', price: 350, type: 'sale'}}),
    }).reasons).toContain('STRUCTURED_SALE_OFFER');
    expect(evaluateModerationCandidate({ ...row, raw_text: 'Siem Reap. Rent $390/month.' }).reasons)
      .toEqual(expect.arrayContaining(['MONTHLY_PRICE_NOT_CONFIRMED_BY_SOURCE', 'CONTRADICTORY_MONTHLY_PRICES']));
  });

  it('holds a reposted old original despite its recent ingestion and fresh price', () => {
    const result = evaluateModerationCandidate({ ...base,
      original_published_at: '2026-03-27T22:38:54Z', first_source_seen_at: new Date().toISOString() });
    expect(result.reasons).toContain('ORIGINAL_PUBLICATION_TOO_OLD');
    expect(result.approved).toBe(false);
  });

  it('holds potential duplicate listings even with different source URLs', () => {
    const result = evaluateModerationCandidate({ ...base, matching_active_listings: 1 });
    expect(result.reasons).toContain('POSSIBLE_DUPLICATE_LISTING');
  });

  it('does not hold missing bedrooms, but still holds unverified publication age', () => {
    const result = evaluateModerationCandidate({ ...base, bedrooms: null,
      original_published_at: null, first_source_seen_at: null,
      raw_text: 'Siem Reap house for rent, 2- Bedrooms. Rent $350/month.' });
    expect(result.reasons).toEqual(['SOURCE_FRESHNESS_UNVERIFIED']);
  });

  it('approves an otherwise verified source despite missing optional bedroom extraction', () => {
    expect(evaluateModerationCandidate({ ...base, bedrooms: null })).toEqual({ approved: true, reasons: [] });
  });

  it('holds an existing bedroom assertion the source never makes, while a null count stays eligible', () => {
    const row = { ...base, price: 50000, bedrooms: 5,
      title: '5 Bedroom Shophouse', description: 'A five-bedroom shophouse is available.',
      raw_text: 'Shophouse for rent in Siem Reap, Svay Dangkum. Rent $500/month. Office use allowed.',
      raw_payload_json: JSON.stringify({ listing: { price: 500, city: 'siem_reap', type: 'rent' } }),
    };
    expect(evaluateModerationCandidate(row).reasons).toContain('UNSUPPORTED_CANONICAL_BEDROOM_COUNT');
    expect(evaluateModerationCandidate({ ...row, bedrooms: null, title: 'Shophouse',
      description: 'Office use allowed.' })).toEqual({ approved: true, reasons: [] });
  });

  it('accepts rent stated in the verbatim Khmer24 heading even if the body omits it', () => {
    const result = evaluateModerationCandidate({ ...base,
      raw_text: 'Siem Reap. $350/month. 2 bedrooms.',
      raw_payload_json: JSON.stringify({ listing: {
        source_title: 'Apartment for rent in Siem Reap', price: 350, city: 'siem_reap', type: 'rent',
      } }),
    });
    expect(result).toEqual({ approved: true, reasons: [] });
    const noOriginalTitle = evaluateModerationCandidate({ ...base,
      raw_text: 'Siem Reap. $350/month. 2 bedrooms.',
    });
    expect(noOriginalTitle).toEqual({ approved: true, reasons: [] });
  });

  it('accepts a bare monthly-price rental, but holds mismatched or ambiguous monthly amounts', () => {
    const row = { ...base, raw_text: '2 bedrooms apartment in Siem Reap. $350/month.',
      raw_payload_json: JSON.stringify({listing: {price:350,city:'siem_reap',type:'rent'}}) };
    expect(evaluateModerationCandidate(row)).toEqual({approved:true,reasons:[]});
    expect(evaluateModerationCandidate({...row,raw_text:'2 bedrooms in Siem Reap. $300/month.'}).reasons)
      .toEqual(expect.arrayContaining(['SOURCE_RENT_NOT_EXPLICIT','MONTHLY_PRICE_NOT_CONFIRMED_BY_SOURCE']));
    expect(evaluateModerationCandidate({...row,raw_text:'2 bedrooms in Siem Reap. $350/month or $400/month.'}).reasons)
      .toContain('CONTRADICTORY_MONTHLY_PRICES');
    expect(evaluateModerationCandidate({...row,raw_text:'House for sale in Siem Reap. $350/month.'}).reasons)
      .toContain('MIXED_OR_SALE_OFFER');
  });

  it('uses an Asking Price as monthly only when a Facebook rent group and explicit rent offer corroborate it', () => {
    const row = { ...base, source_type: 'FACEBOOK_GROUP', price: 45000,
      title: '2BR apartment for rent', bedrooms: 2,
      raw_text: 'Apartment for rent in Siem Reap, Svay Dangkum. Asking Price: $450. 2 bedrooms.',
      raw_payload_json: JSON.stringify({ listing: { price: 450, city: 'siem_reap', type: 'rent' } }),
    };
    expect(evaluateModerationCandidate({ ...row, group_name: 'Cheap Rent Siem Reap' }))
      .toEqual({ approved: true, reasons: [] });
    expect(evaluateModerationCandidate({ ...row, group_name: 'Siem Reap Real Estate' }).reasons)
      .toContain('MONTHLY_PRICE_NOT_CONFIRMED_BY_SOURCE');
    expect(evaluateModerationCandidate({ ...row, group_name: 'Cheap Rent Siem Reap',
      raw_text: row.raw_text.replace('for rent', 'in the city') }).reasons)
      .toEqual(expect.arrayContaining(['SOURCE_RENT_NOT_EXPLICIT', 'MONTHLY_PRICE_NOT_CONFIRMED_BY_SOURCE']));
    expect(evaluateModerationCandidate({ ...row, group_name: 'Cheap Rent Siem Reap',
      raw_text: `${row.raw_text} Asking Price: $500.` }).reasons)
      .toContain('MONTHLY_PRICE_NOT_CONFIRMED_BY_SOURCE');
    expect(evaluateModerationCandidate({ ...row, group_name: 'Cheap Rent Siem Reap',
      raw_text: `${row.raw_text} House for sale.` }).reasons)
      .toContain('MIXED_OR_SALE_OFFER');
  });

  it('holds contradictory bedroom counts from the original, even if canonical rooms are unknown', () => {
    const result = evaluateModerationCandidate({ ...base, bedrooms: null,
      raw_text: `${base.raw_text}\nBedrooms: 3`,
    });
    expect(result.reasons).toContain('CONTRADICTORY_SOURCE_BEDROOM_COUNTS');
  });

  it('does not treat a corroborated 3+4 villa compound as a source bedroom contradiction', () => {
    const row = { ...base, title: '7 Bedroom Villa Compound', description: 'Seven bedrooms, eight bathrooms.',
      bedrooms: 7, bathrooms: 8, price: 250000,
      raw_text: '7 Bedrooms, 8 Bathrooms. Main 3-Bedroom Villa. ' +
        'Two Separate Bungalows - 4 additional Bedrooms. ' +
        'Located in Sla Kram, Siem Reap. $2,500 per month.',
      raw_payload_json: JSON.stringify({ listing: { source_title:
        'Siem Reap, Private 7-Bedroom villa complex for Rent', price: 2500, type: 'rent', city: 'siem_reap' } }),
    };
    expect(evaluateModerationCandidate(row)).toEqual({ approved: true, reasons: [] });
    expect(evaluateModerationCandidate({ ...row, bedrooms: 6 }).reasons)
      .toContain('BEDROOMS_CONTRADICT_SOURCE');
  });

  it('does not compare itemized unit bathrooms with the compound-wide total', () => {
    const row = { ...base, title: '7 Bedroom Villa Compound', description: 'Seven bedrooms, seven bathrooms.',
      bedrooms: 7, bathrooms: 7,
      raw_text: 'Villa compound for rent in Siem Reap, Svay Dangkum. Rent $350/month.\n' +
        '7 Bedrooms, 7 Bathrooms.\n1-Wood House: 1-Bed, 1-Bath.\n' +
        '6-Unit Rooms: 1-Bed, 1-Bath each.',
    };
    expect(evaluateModerationCandidate(row)).toEqual({ approved: true, reasons: [] });
  });

  it('holds contradictory bathroom evidence, but allows missing bathrooms', () => {
    const row = { ...base, raw_text: `${base.raw_text}\n3 bathrooms` };
    expect(evaluateModerationCandidate(row)).toEqual({ approved: true, reasons: [] });
    expect(evaluateModerationCandidate({ ...row, bathrooms: 2 }).reasons)
      .toContain('BATHROOMS_CONTRADICT_SOURCE');
    expect(evaluateModerationCandidate({ ...row, raw_text: `${row.raw_text}\n4 bathrooms` }).reasons)
      .toContain('CONTRADICTORY_SOURCE_BATHROOM_COUNTS');
  });

  it('uses the source heading for exact city evidence, not the advertised Pub Street shortcut', () => {
    const result = evaluateModerationCandidate({ ...base, bedrooms: null, title: 'Apartment for rent',
      raw_text: 'Rent $350/month. 5 minutes to Pub Street',
      raw_payload_json: JSON.stringify({ listing: { source_title: 'Apartment in Siem Reap for rent', price: 350 } }),
    });
    expect(result).toEqual({ approved: true, reasons: [] });
  });

  it('does not treat Pub Street advertising as source-confirmed property geography', () => {
    const result = evaluateModerationCandidate({ ...base, raw_text: 'Rent $350/month. Five minutes to Pub Street' });
    expect(result.approved).toBe(false);
    expect(result.reasons).toContain('PROBABLE_CITY_REQUIRES_REVIEW');
  });

  it('approves an otherwise corroborated rental located in a named Siem Reap sangkat', () => {
    const result = evaluateModerationCandidate({ ...base,
      raw_text: 'House for rent. 📍Located in Svay Dangkum, 7 minutes to Pub Street. Rent $350/month. 2 bedrooms',
    });
    expect(result).toEqual({approved:true,reasons:[]});
  });

  it('preserves manual review, alias conflicts, source sale and bedroom contradictions', () => {
    const result = evaluateModerationCandidate({ ...base, review_reason: 'Legacy identity alias conflict; manual review required',
      legacy_aliases: 1, conflicting_url: 1, bedrooms: 3,
      raw_text: `${base.raw_text} House for sale too` });
    expect(result.approved).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'PRIOR_MANUAL_REVIEW_REASON', 'LEGACY_ALIAS_REQUIRES_EXISTING_REVIEW',
      'SOURCE_URL_CONFLICT', 'MIXED_OR_SALE_OFFER', 'BEDROOMS_CONTRADICT_SOURCE',
    ]));
  });
});

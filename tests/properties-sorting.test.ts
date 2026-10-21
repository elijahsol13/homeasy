import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { PropertiesRepository } from '../src/database/repositories/properties.repo';

describe('PropertiesRepository price sorting', () => {
  let db: DatabaseSync;
  let repository: PropertiesRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    repository = new PropertiesRepository(db);
  });

  afterEach(() => db.close());

  it('sorts known prices both ways, keeps non-positive prices last, and breaks equal-price ties by id', () => {
    let nextHash = 0;
    const add = (price: number) => repository.insertProperty({
      hash: `sort-${++nextHash}`,
      title: 'Apartment for rent in Siem Reap',
      description: '',
      price,
      currency: 'USD',
      type: 'rent',
      category: 'apartment',
      bedrooms: 1,
      bathrooms: 1,
      deposit: null,
      min_lease: null,
      has_pool: null,
      location: 'Sala Kamreuk',
      city: 'siem_reap',
      maps_url: null,
      source_url: null,
      original_url: '',
      photos: [],
      direct_contact: {},
      posted_at: '2026-10-01T00:00:00Z',
    }).id;

    const firstTie = add(10000);
    const secondTie = add(10000);
    const cheaper = add(5000);
    const zero = add(0);
    const negative = add(-100);

    const ascending = repository.searchProperties({ sort: 'price_asc' }).items.map((property) => property.id);
    expect(ascending.slice(0, 3)).toEqual([cheaper, secondTie, firstTie]);
    expect(ascending.slice(3).sort((a, b) => a - b)).toEqual([zero, negative].sort((a, b) => a - b));

    const descending = repository.searchProperties({ sort: 'price_desc' }).items.map((property) => property.id);
    expect(descending.slice(0, 3)).toEqual([secondTie, firstTie, cheaper]);
    expect(descending.slice(3).sort((a, b) => a - b)).toEqual([zero, negative].sort((a, b) => a - b));
  });
});

describe('PropertiesRepository bedroom selections', () => {
  let db: DatabaseSync;
  let repository: PropertiesRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    repository = new PropertiesRepository(db);
    for (const bedrooms of [1, 2, 3, 4, 5, 6]) {
      repository.insertProperty({
        hash: `bedroom-${bedrooms}`,
        title: `${bedrooms} bedroom apartment`,
        description: 'For rent in Sala Kamreuk',
        price: bedrooms * 10000,
        currency: 'USD', type: 'rent', category: 'apartment', bedrooms,
        bathrooms: 1, deposit: null, min_lease: null, has_pool: null,
        location: 'Sala Kamreuk', city: 'siem_reap', maps_url: null,
        source_url: null, original_url: '', photos: [], direct_contact: {},
        posted_at: '2026-10-01T00:00:00Z',
      });
    }
  });

  afterEach(() => db.close());

  const matchedBedrooms = (repo: PropertiesRepository, bedrooms: number[]) =>
    repo.searchProperties({ bedrooms }).items.map((item) => item.bedrooms).sort((a, b) => Number(a) - Number(b));

  it('treats 4+ as at least four bedrooms, excluding three', () => {
    expect(matchedBedrooms(repository, [4])).toEqual([4, 5, 6]);
  });

  it('unions 2 BR and 4+ BR and keeps 1/2/3 BR exact', () => {
    expect(matchedBedrooms(repository, [2, 4])).toEqual([2, 4, 5, 6]);
    for (const exact of [1, 2, 3]) {
      expect(matchedBedrooms(repository, [exact])).toEqual([exact]);
    }
  });

  it('combines 4+ with other filters and preserves price sorting and pagination', () => {
    const result = repository.searchProperties({
      city: 'siem_reap', type: 'rent', category: 'apartment',
      locations: ['Sala Kamreuk'], bedrooms: [4], maxPrice: 50000,
      sort: 'price_asc', limit: 1, offset: 1,
    });
    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.bedrooms)).toEqual([5]);
  });
});

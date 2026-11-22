import { aggregateUnlocatedMapItems } from '../src/modules/api/map-clusters';

describe('aggregateUnlocatedMapItems', () => {
  it('does not promote Wat Bo landmarks into verified district clusters', () => {
    const clusters = aggregateUnlocatedMapItems([
      { city: 'siem_reap', location: 'Wat Bo', locationKey: null, priceUsd: 200 },
      { city: 'siem_reap', location: 'Sla Kram', locationKey: 'siem_reap:sla_kram', priceUsd: 350 },
    ], 'siem_reap');

    expect(clusters).toHaveLength(2);
    expect(clusters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        location: 'Siem Reap — area unverified', locationKey: null,
        count: 1, minPriceUsd: 200, maxPriceUsd: 200,
        coordinatePrecision: 'city', locationAliases: ['Wat Bo'],
      }),
      expect.objectContaining({
        location: 'Sla Kram', locationKey: 'siem_reap:sla_kram',
        count: 1, minPriceUsd: 350, maxPriceUsd: 350,
        coordinatePrecision: 'district', locationAliases: ['Sla Kram'],
      }),
    ]));
  });

  it('groups unrecognized and cross-city locations into one explicit city-level marker', () => {
    const clusters = aggregateUnlocatedMapItems([
      { city: 'siem_reap', location: 'Pub Street', locationKey: null, priceUsd: 100 },
      { city: 'siem_reap', location: 'Riverside', locationKey: 'phnom_penh:daun_penh', priceUsd: 0 },
      { city: 'siem_reap', location: 'Behind Ford showroom', locationKey: null, priceUsd: 250 },
    ], 'siem_reap');

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      location: 'Siem Reap — area unverified',
      locationKey: null,
      count: 3,
      minPriceUsd: 0,
      maxPriceUsd: 250,
      coordinatePrecision: 'city',
      lat: 13.3611,
      lng: 103.8596,
    });
  });

  it('uses verified Srangae key but keeps Phsa Kraom residence unverified', () => {
    const clusters = aggregateUnlocatedMapItems([
      {
        city: 'siem_reap',
        location: 'Location: Sangkat Srangae, Siem Reap City',
        locationKey: 'siem_reap:srangae',
        priceUsd: 175,
      },
      {
        city: 'siem_reap',
        location: 'Phsa Kraom Residence',
        locationKey: null,
        priceUsd: 175,
      },
    ], 'siem_reap');

    expect(clusters).toHaveLength(2);
    expect(clusters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        location: 'Srangae',
        locationKey: 'siem_reap:srangae',
        coordinatePrecision: 'district',
        lat: 13.365,
        lng: 103.81,
      }),
      expect.objectContaining({
        location: 'Siem Reap — area unverified',
        locationKey: null,
        coordinatePrecision: 'city',
      }),
    ]));
  });

  it('groups a landmark with a confirmed key alongside the same district', () => {
    const clusters = aggregateUnlocatedMapItems([
      { city: 'siem_reap', location: 'Wat Bo', locationKey: 'siem_reap:sala_kamreuk', priceUsd: 250 },
      { city: 'siem_reap', location: 'Sala Kamreuk', locationKey: 'siem_reap:sala_kamreuk', priceUsd: 300 },
    ], 'siem_reap');

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      location: 'Sala Kamreuk',
      locationKey: 'siem_reap:sala_kamreuk',
      coordinatePrecision: 'district',
      count: 2,
      minPriceUsd: 250,
      maxPriceUsd: 300,
    });
    expect(clusters[0].locationAliases).toEqual(['Wat Bo', 'Sala Kamreuk']);
  });
});

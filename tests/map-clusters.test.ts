import { aggregateUnlocatedMapItems } from '../src/modules/api/map-clusters';

describe('aggregateUnlocatedMapItems', () => {
  it('keeps Wat Bo (Sala Kamreuk) distinct from Sla Kram in map clusters', () => {
    const clusters = aggregateUnlocatedMapItems([
      { city: 'siem_reap', location: 'Wat Bo', locationKey: null, priceUsd: 200 },
      { city: 'siem_reap', location: 'Sla Kram', locationKey: 'siem_reap:sla_kram', priceUsd: 350 },
    ], 'siem_reap');

    expect(clusters).toHaveLength(2);
    expect(clusters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        location: 'Sala Kamreuk', locationKey: 'siem_reap:sala_kamreuk',
        count: 1, minPriceUsd: 200, maxPriceUsd: 200,
        coordinatePrecision: 'district', locationAliases: ['Wat Bo'],
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

  it('maps explicit Srangae address text and Phsa Kraom residence to district clusters', () => {
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
        location: 'Svay Dangkum',
        locationKey: 'siem_reap:svay_dangkum',
        coordinatePrecision: 'district',
      }),
    ]));
  });
});

import { assessSiemReapGeography as assess } from '../src/modules/parser/source-geography';

describe('source-first Siem Reap moderation geography', () => {
  test('generated Phnom Penh title cannot reject a post describing a home near Pub Street', () => {
    expect(assess({title:'2BR Apartment in Phnom Penh',city:'siem_reap',
      rawText:'2 bedroom apartment for rent, 1.1 km from Pub Street, $550/month'})).toEqual({
      tier:'GEOGRAPHY_CONFLICT',flags:['GEOGRAPHY_NEEDS_SOURCE_REVIEW'],
    });
  });

  test('owner relocated to Phnom Penh is not evidence that the villa is there', () => {
    expect(assess({title:'4BR Detached Villa',city:'siem_reap',
      rawText:'Villa with garden. Owner relocated to Phnom Penh.'})).toEqual({
      tier:'GEOGRAPHY_CONFLICT',flags:['GEOGRAPHY_NEEDS_SOURCE_REVIEW'],
    });
  });

  test('an explicitly located outside-city source is rejected even with a Siem Reap generated title', () => {
    expect(assess({title:'Villa in Siem Reap',city:'siem_reap',rawText:'Location: Phnom Penh\nVilla for rent $500/month'})).toEqual({
      tier:'CONTRADICTION_CITY',flags:['SOURCE_OUTSIDE_CITY'],
    });
  });

  test('source containing contradictory local and outside-city location assertions needs review', () => {
    expect(assess({rawText:'Location: Phnom Penh\nApartment near Pub Street for rent'})).toEqual({
      tier:'GEOGRAPHY_CONFLICT',flags:['GEOGRAPHY_NEEDS_SOURCE_REVIEW'],
    });
  });

  test('a model-derived other-city code cannot override the original source', () => {
    expect(assess({rawText:'Rental apartment in Siem Reap',city:'phnom_penh'})).toEqual({
      tier:'GEOGRAPHY_CONFLICT',flags:['GEOGRAPHY_NEEDS_SOURCE_REVIEW'],
    });
  });

  test('source with explicit Siem Reap remains eligible after other policy checks', () => {
    expect(assess({title:'Apartment',rawText:'Apartment for rent, Siem Reap, $270/month'})).toEqual({tier:'EXACT_CITY',flags:[]});
  });

  test('local landmark without city supports probable evidence, never exact proof', () => {
    expect(assess({rawText:'Apartment near Old Market, $250 per month'})).toEqual({
      tier:'PROBABLE_CITY',flags:['PROBABLE_CITY_REQUIRES_REVIEW'],
    });
  });

  test('an original, property-specific sangkat assertion confirms the city without inventing coordinates', () => {
    for (const rawText of [
      '📍Located in Svay Dangkum, 7 minutes to Pub Street',
      '📍Located in Svay Dankum, 2 minutes to Old Market',
      '✅ Svay Dangkum, 15 minutes walk to Pub Street (1 km)',
      '✅ City Center, Svay Dakgkum, 5 minutes walk to Pub Street',
      'The site is located in Sala Kamraeuk area',
      'Property location: Sla Kram',
    ]) {
      expect(assess({rawText})).toEqual({tier:'EXACT_CITY',flags:[]});
    }
  });

  test('agency address and proximity-only marketing cannot verify the property district', () => {
    for (const rawText of [
      'Villa for rent, five minutes to Pub Street',
      'Office located in Svay Dangkum; villa near Pub Street',
      '📍 Office location: Svay Dangkum, apartments near Old Market',
    ]) {
      expect(assess({rawText})).toEqual({
        tier:'PROBABLE_CITY',flags:['PROBABLE_CITY_REQUIRES_REVIEW'],
      });
    }
  });

  test('city inherited from registry alone is probable, unknown post location requires manual review', () => {
    expect(assess({sourceCity:'siem_reap',rawText:'Apartment for rent'})).toEqual({
      tier:'PROBABLE_CITY',flags:['PROBABLE_CITY_REQUIRES_REVIEW'],
    });
    expect(assess({city:'siem_reap',rawText:'Apartment for rent'})).toEqual({
      tier:'UNKNOWN_CITY',flags:['INSUFFICIENT_SOURCE_GEOGRAPHY'],
    });
  });

  test('LLM-derived location alone never supplies exact source city evidence', () => {
    expect(assess({explicitLocation:'Siem Reap',rawText:'Furnished apartment for rent'})).toEqual({
      tier:'PROBABLE_CITY',flags:['PROBABLE_CITY_REQUIRES_REVIEW'],
    });
  });

  test('original Cambodian source location remains strong rejection evidence', () => {
    expect(assess({rawText:'ទីតាំង: ភ្នំពេញ\nផ្ទះជួល'})).toEqual({
      tier:'CONTRADICTION_CITY',flags:['SOURCE_OUTSIDE_CITY'],
    });
  });
});

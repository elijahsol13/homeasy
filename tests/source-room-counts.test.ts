import { sourceRoomCounts } from '../src/modules/parser/source-room-counts';
import { Khmer24LiveAdapter } from '../src/modules/parser/live-source-adapters';

describe('deterministic original-source room counts', () => {
  it.each([
    ['3 bedrooms', 3], ['2- Bedrooms', 2], ['Bedrooms: 4', 4],
    ['2-bedroom house', 2], ['Number of bedrooms: 4', 4],
    ['5 bedrooms', 5], ['1 Bedroom', 1], ['2BR', 2], ['Bedroom 02', 2],
  ])('extracts Khmer24 source syntax %s', (text, count) => {
    expect(sourceRoomCounts(text)).toMatchObject({ bedrooms: count, conflictingBedrooms: false });
  });

  it('extracts bathroom and bedroom labels independently, including CRLF', () => {
    expect(sourceRoomCounts('Number of bedrooms: 4\r\nNumber of bathrooms: 5')).toMatchObject({
      bedrooms: 4, bathrooms: 5, conflictingBedrooms: false, conflictingBathrooms: false,
    });
  });

  it('does not reuse the next room field as a second count in inline text', () => {
    expect(sourceRoomCounts('Apartment Wat Bo for rent $450 3 bedrooms 2 bathrooms')).toEqual({
      bedrooms: 3, bathrooms: 2, conflictingBedrooms: false, conflictingBathrooms: false,
    });
    expect(sourceRoomCounts('Bedroom 3 Bathroom 2')).toEqual({
      bedrooms: 3, bathrooms: 2, conflictingBedrooms: false, conflictingBathrooms: false,
    });
  });

  it('parses written English room counts without crossing bedroom and bathroom fields', () => {
    expect(sourceRoomCounts('Two bedrooms, three bathrooms')).toEqual({
      bedrooms: 2, bathrooms: 3, conflictingBedrooms: false, conflictingBathrooms: false,
    });
    expect(sourceRoomCounts('Bedroom twenty-one, Bathroom two')).toEqual({
      bedrooms: 21, bathrooms: 2, conflictingBedrooms: false, conflictingBathrooms: false,
    });
  });

  it('recognizes numbered Khmer24 labels without colons', () => {
    expect(sourceRoomCounts('Bedroom 02\nBathroom 03')).toMatchObject({
      bedrooms: 2, bathrooms: 3, conflictingBedrooms: false, conflictingBathrooms: false,
    });
  });

  it('reads explicit Khmer bedroom and bathroom counts in either numeral system', () => {
    expect(sourceRoomCounts('បន្ទប់គេង 2\nបន្ទប់ទឹក 3')).toMatchObject({
      bedrooms: 2, bathrooms: 3, conflictingBedrooms: false, conflictingBathrooms: false,
    });
    expect(sourceRoomCounts('០២ បន្ទប់គេង, បន្ទប់ទឹក ០៣')).toMatchObject({
      bedrooms: 2, bathrooms: 3, conflictingBedrooms: false, conflictingBathrooms: false,
    });
    expect(sourceRoomCounts('បន្ទប់គេង 4+1')).toMatchObject({
      bedrooms: null, conflictingBedrooms: true,
    });
  });

  it('does not confuse beds/furniture with bedrooms or guess a studio layout', () => {
    expect(sourceRoomCounts('2 beds, sofa bed')).toMatchObject({ bedrooms: null, conflictingBedrooms: false });
  });

  it('maps an explicit studio label to zero separate bedrooms', () => {
    expect(sourceRoomCounts('Studio apartment for rent')).toMatchObject({ bedrooms: 0, conflictingBedrooms: false });
  });

  it('marks multiple distinct room counts as contradictory and leaves the count unset', () => {
    expect(sourceRoomCounts('2 Bedrooms\nBedrooms: 3\n1 bathroom\n2 baths')).toEqual({
      bedrooms: null, bathrooms: null, conflictingBedrooms: true, conflictingBathrooms: true,
    });
  });

  it('reconciles only explicitly qualified villa component counts against a stated total', () => {
    const original = 'Siem Reap, Private 7-Bedroom villa complex for Rent (#39101)\n' +
      '7 Bedrooms, 8 Bathrooms\nMain 3-Bedroom Villa - approximately 234 sqm\n' +
      'Two Separate Bungalows - 4 additional Bedrooms\n$2,500 per month';
    expect(sourceRoomCounts(original)).toEqual({ bedrooms: 7, bathrooms: 8,
      conflictingBedrooms: false, conflictingBathrooms: false });
    expect(sourceRoomCounts(original.replace('7 Bedrooms', '6 Bedrooms').replace('7-Bedroom', '6-Bedroom')))
      .toMatchObject({ bedrooms: null, conflictingBedrooms: true });
    expect(sourceRoomCounts(original.replace('4 additional Bedrooms', '4 Bedrooms')))
      .toMatchObject({ bedrooms: null, conflictingBedrooms: true });
    expect(sourceRoomCounts(original + '\nGuest unit: 2 Bedrooms'))
      .toMatchObject({ bedrooms: null, conflictingBedrooms: true });
  });

  it('does not treat itemized compound bathrooms as the overall bathroom total', () => {
    const components = '1-Wood House: 1-Bed, 1-Bath\n6-Unit Rooms: 1-Bed, 1-Bath each';
    expect(sourceRoomCounts(components)).toMatchObject({
      bathrooms: null, conflictingBathrooms: false,
    });
    expect(sourceRoomCounts(`7 Bedrooms, 7 Bathrooms\n${components}`)).toMatchObject({
      bedrooms: 7, bathrooms: 7, conflictingBedrooms: false, conflictingBathrooms: false,
    });
    expect(sourceRoomCounts(`7 Bathrooms\n${components}\nOverall: 8 Bathrooms`))
      .toMatchObject({ bathrooms: null, conflictingBathrooms: true });
  });

  it.each(['Bedrooms: 4 + 1', '4+1 bedrooms'])('does not silently accept ambiguous compound bedrooms: %s', text => {
    expect(sourceRoomCounts(text)).toMatchObject({ bedrooms: null, conflictingBedrooms: true });
  });

  it('uses original Khmer24 title/body counts even when AI missed them', () => {
    const adapter = new Khmer24LiveAdapter(async function* () {});
    const normalized = adapter.normalize({ sourceId: 'siem-reap', sourceName: 'Khmer24',
      listing: { source_url: 'https://www.khmer24.com/en/post-adid-12345', title: 'AI title',
        source_title: '2-Bedroom house for rent',
        raw_text: 'Price: $350/month. 2 bedrooms and 3 bathrooms', price: 350,
        city: 'siem_reap', category: 'house',
        listing_facts_json: JSON.stringify({ bedrooms: null, bathrooms: null }), photos: [],
      },
    });
    expect((normalized.raw as unknown as { listingExtraction: Record<string, unknown> }).listingExtraction)
      .toMatchObject({ bedrooms: 2, bathrooms: 3 });
    expect((normalized.raw.listing as { source_title?: string }).source_title)
      .toBe('2-Bedroom house for rent');
  });
});

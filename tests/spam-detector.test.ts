import { isNonRealEstateSpam } from '../src/modules/parser/spam-detector';

describe('Non-real-estate spam detector', () => {
  test('does not flag genuine residential titles', () => {
    expect(isNonRealEstateSpam('2BR Apartment for rent in Sla Kram', '$350/month, min 6 months').isSpam).toBe(false);
    expect(isNonRealEstateSpam('Private Villa with pool near Pub Street', '').isSpam).toBe(false);
    expect(isNonRealEstateSpam('Studio condo for rent', '').isSpam).toBe(false);
  });

  test('flags housing-titled posts that actually sell vehicles or gadgets', () => {
    // One housing keyword alone does NOT bypass all other evidence.
    const title = 'Apartment near Pub Street';
    const description = 'Also selling my Honda PCX and a used iPhone. Contact me.';
    expect(isNonRealEstateSpam(title, description).isSpam).toBe(true);
  });

  test('flags pure land sales', () => {
    expect(isNonRealEstateSpam('ដីសំរាប់លក់', 'Land for sale 10x20m in Sla Kram').isSpam).toBe(true);
  });

  test('monthly rental evidence lowers the spam score below the threshold', () => {
    // Vehicle term alone scores +4, but residential title (-2), monthly rent (-2) and
    // bedroom mention (-1) drop the total to -1, so it must stay NOT spam.
    expect(
      isNonRealEstateSpam('1 bedroom apartment with PCX parking available', '$300 per month, 1BR').isSpam,
    ).toBe(false);
  });

  test('Khmer house sale with a car-related landmark is not mistaken for vehicle spam', () => {
    const title = 'ផ្ទះដីលក់បន្ទាន់ ជិតឆៀកឡាន វត្តស្វាយធំ';
    const description = 'ទីតាំងដី: ផ្ទះនៅជិតឆៀកឡាន និងវត្តស្វាយធំ';
    expect(isNonRealEstateSpam(title, description).isSpam).toBe(false);
  });

  test('a real Khmer vehicle advert is still filtered', () => {
    expect(isNonRealEstateSpam('លក់ឡាន', 'មានការគ្រី និង ស្លាកលេខ').isSpam).toBe(true);
  });
});

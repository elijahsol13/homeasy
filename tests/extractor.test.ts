import {
  extractElectricity,
  extractWater,
  extractPropertyType,
  extractBathrooms,
  extractLocation,
  extractType,
  isModelAvailable,
  recordModelFailure,
  recordModelSuccess,
  resetCircuitBreakers,
  getModelBreaker,
} from '../src/modules/parser/extractor';

describe('Extractor: Cambodian Utilities & Property Types', () => {
  describe('Electricity Extraction', () => {
    test('extracts Included / Free electricity', () => {
      expect(extractElectricity('Apartment with free electricity and wifi')).toBe('Included');
      expect(extractElectricity('Electricity: included in rent')).toBe('Included');
      expect(extractElectricity('All inclusive hotel room')).toBe('Included');
    });

    test('extracts EDC / State Rate', () => {
      expect(extractElectricity('Electricity: EDC rate')).toBe('EDC (State Rate) ~$0.20/kWh');
      expect(extractElectricity('State electric rate billed monthly')).toBe('EDC (State Rate) ~$0.20/kWh');
      expect(extractElectricity('ភ្លើងរដ្ឋ តាមកុងទ័រ')).toBe('EDC (State Rate) ~$0.20/kWh');
    });

    test('extracts fixed USD rates per kWh', () => {
      expect(extractElectricity('Electricity $0.25/kwh')).toBe('Fixed Rate ($0.25/kWh)');
      expect(extractElectricity('Power: 0.30$/kWh')).toBe('Fixed Rate ($0.30/kWh)');
      expect(extractElectricity('Electric 0.25 per kwh')).toBe('Fixed Rate ($0.25/kWh)');
      expect(extractElectricity('Electricity: 0.25$')).toBe('Fixed Rate ($0.25/kWh)');
      expect(extractElectricity('affordable electricity at $0.25 per kwh')).toBe('Fixed Rate ($0.25/kWh)');
    });

    test('extracts fixed KHR rates per kWh', () => {
      expect(extractElectricity('Electric 1000r/kwh')).toBe('Fixed Rate (1000៛/kWh)');
      expect(extractElectricity('Electricity: 1200 riel per kwh')).toBe('Fixed Rate (1200៛/kWh)');
      expect(extractElectricity('electricity 1,000 riels/kwh')).toBe('Fixed Rate (1000៛/kWh)');
      expect(extractElectricity('ភ្លើង 1000៛/unit')).toBe('Fixed Rate (1000៛/kWh)');
      expect(extractElectricity('Electricity: EDC (720 Riels)')).toBe('EDC (State Rate) ~$0.20/kWh');
    });

    test('returns null when electricity is not mentioned', () => {
      expect(extractElectricity('Nice 2 bedroom house near Old Market.')).toBeNull();
      expect(extractElectricity('Only 0.3 miles to pub street')).toBeNull();
    });
  });

  describe('Water Extraction', () => {
    test('extracts Included / Free water', () => {
      expect(extractWater('Free water and garbage collection')).toBe('Included');
      expect(extractWater('Water: included')).toBe('Included');
      expect(extractWater('ទឹកឥតគិតថ្លៃ')).toBe('Included');
    });

    test('extracts State Rate water', () => {
      expect(extractWater('State water rate directly from meter')).toBe('State Rate (~1000៛/m³)');
      expect(extractWater('ទឹកដ្ឋ តាមកុងទ័រ')).toBe('State Rate (~1000៛/m³)');
      expect(extractWater('Water: 1000 r/m3')).toBe('State Rate (~1000៛/m³)');
      expect(extractWater('Water: PPWSA state rate')).toBe('State Rate (~1000៛/m³)');
    });

    test('extracts fixed water rates per person or per month', () => {
      expect(extractWater('Water: $5/person/month')).toBe('Fixed ($5/person)');
      expect(extractWater('Water $5/pax')).toBe('Fixed ($5/person)');
      expect(extractWater('Water: $10/month')).toBe('Fixed ($10/month)');
      expect(extractWater('Water: $5')).toBe('Fixed ($5/month)');
      expect(extractWater('Water: 5$/mo')).toBe('Fixed ($5/month)');
    });

    test('extracts fixed water rates per m3', () => {
      expect(extractWater('water 2,000 riels/m³')).toBe('Fixed Rate (2000៛/m³)');
      expect(extractWater('Water: $0.50/m3')).toBe('Fixed Rate ($0.50/m³)');
      expect(extractWater('water 2500 riel/m3')).toBe('Fixed Rate (2500៛/m³)');
    });

    test('returns null when water is not mentioned', () => {
      expect(extractWater('Studio apartment with kitchen and balcony.')).toBeNull();
      expect(extractWater('Hot water system in bathroom')).toBeNull();
    });
  });

  describe('Property Type Classification', () => {
    test('classifies Flat House (Shophouse / ផ្ទះល្វែង)', () => {
      expect(extractPropertyType('Modern flat house for rent with ground floor for shop.')).toBe('Flat House');
      expect(extractPropertyType('Shophouse on main road near Phsar Leu.')).toBe('Flat House');
      expect(extractPropertyType('flathouse E0 E1 for rent')).toBe('Flat House');
      expect(extractPropertyType('ផ្ទះល្វែង សម្រាប់ជួល')).toBe('Flat House');
    });

    test('classifies Private Villa', () => {
      expect(extractPropertyType('Private villa with 4 bedrooms, private pool and garden.')).toBe('Private Villa');
      expect(extractPropertyType('Detached luxury villa in Siem Reap.')).toBe('Private Villa');
      expect(extractPropertyType('ផ្ទះវីឡា ស្អាត')).toBe('Private Villa');
    });

    test('classifies Private House', () => {
      expect(extractPropertyType('Private house for rent in Svay Dangkum.')).toBe('Private House');
      expect(extractPropertyType('Detached house with front yard.')).toBe('Private House');
      expect(extractPropertyType('Traditional wooden house near river.')).toBe('Private House');
    });

    test('classifies Hotel Room', () => {
      expect(extractPropertyType('Boutique hotel room with pool and breakfast included.')).toBe('Hotel Room');
      expect(extractPropertyType('Hotel suite available for monthly rental.', 'hotel')).toBe('Hotel Room');
      expect(extractPropertyType('Clean room', 'hotel')).toBe('Hotel Room');
    });

    test('classifies Condo & Apartment', () => {
      expect(extractPropertyType('Modern condo on 15th floor with fitness gym.')).toBe('Condo');
      expect(extractPropertyType('Serviced apartment 1BR in BKK1.')).toBe('Apartment');
    });
  });

  describe('Standard Extraction Utilities', () => {
    test('extracts bathrooms count', () => {
      expect(extractBathrooms('2 bedrooms, 2 bathrooms')).toBe(2);
      expect(extractBathrooms('3បន្ទប់គេង 4បន្ទប់ទឹក')).toBe(4);
    });

    test('extracts Sangkats in Khmer and English', () => {
      const srLoc = extractLocation('ផ្ទះជួលនៅ សាលាកំរើក');
      expect(srLoc?.location).toBe('Sala Kamreuk');
      expect(srLoc?.city).toBe('siem_reap');

      const ppLoc = extractLocation('Condo for rent in BKK1 Phnom Penh');
      expect(ppLoc?.location).toBe('BKK1');
      expect(ppLoc?.city).toBe('phnom_penh');
    });

    test('extracts type rent vs sale', () => {
      expect(extractType('Beautiful villa for rent')).toBe('rent');
      expect(extractType('House for sale in Siem Reap')).toBe('sale');
    });
  });

  describe('Gemini Model Cascade Circuit Breaker', () => {
    beforeEach(() => {
      resetCircuitBreakers();
    });

    test('models are initially available', () => {
      expect(isModelAvailable('gemini-3.8-flash')).toBe(true);
      expect(isModelAvailable('gemini-3.6-flash')).toBe(true);
    });

    test('trips circuit breaker immediately on 503 Service Unavailable / high demand', () => {
      expect(isModelAvailable('gemini-3.8-flash')).toBe(true);
      recordModelFailure('gemini-3.8-flash', new Error('503 Service Unavailable: The model is overloaded. Please try again later.'));
      expect(isModelAvailable('gemini-3.8-flash')).toBe(false);
      // Other fallback models remain unaffected and ready
      expect(isModelAvailable('gemini-3.6-flash')).toBe(true);
      expect(isModelAvailable('gemini-3.1-flash-lite')).toBe(true);
    });

    test('trips circuit breaker immediately on 429 Quota Exceeded', () => {
      expect(isModelAvailable('gemini-3.5-flash')).toBe(true);
      recordModelFailure('gemini-3.5-flash', new Error('429 Too Many Requests: Quota exceeded for metric'));
      expect(isModelAvailable('gemini-3.5-flash')).toBe(false);
      // Other cascade models remain ready
      expect(isModelAvailable('gemini-3.7-flash')).toBe(true);
      expect(isModelAvailable('gemini-3.5-flash-lite')).toBe(true);
    });

    test('trips circuit breaker after 5 consecutive errors', () => {
      for (let i = 0; i < 4; i++) {
        recordModelFailure('gemini-3.8-flash', new Error('Network timeout'));
        expect(isModelAvailable('gemini-3.8-flash')).toBe(true);
      }
      recordModelFailure('gemini-3.8-flash', new Error('5th error'));
      expect(isModelAvailable('gemini-3.8-flash')).toBe(false);
    });

    test('resets consecutive error count on successful completion', () => {
      recordModelFailure('gemini-3.8-flash', new Error('Network timeout'));
      recordModelFailure('gemini-3.8-flash', new Error('Network timeout'));
      recordModelSuccess('gemini-3.8-flash');
      expect(isModelAvailable('gemini-3.8-flash')).toBe(true);
      const breaker = getModelBreaker('gemini-3.8-flash');
      expect(breaker.consecutiveErrors).toBe(0);
    });
  });
});

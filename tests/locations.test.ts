import {
  formatGoogleMapsUrl,
  findCanonicalLocation,
  extractCoordinatesFromMapsUrl,
  calculateDistanceKm,
  isCoordinateInSanityBounds,
  crossValidateLocation,
} from '../src/config/locations';

describe('Cambodia Locations & Smart Google Maps Link Generator', () => {
  describe('Bakong Landmark Disambiguation', () => {
    it('generates administrative Prasat Bakong District query instead of temple ruin', () => {
      const url = formatGoogleMapsUrl('Bakong', 'siem_reap');
      expect(url).toContain('https://www.google.com/maps/search/?api=1&query=');
      const decoded = decodeURIComponent(url);
      expect(decoded).toContain('Prasat Bakong District, Siem Reap, Cambodia');
      expect(decoded).not.toBe('https://www.google.com/maps/search/?api=1&query=Bakong, Siem Reap, Cambodia');
    });

    it('matches Bakong alias "prasat bakong"', () => {
      const match = findCanonicalLocation('Prasat Bakong', 'siem_reap');
      expect(match).toBeDefined();
      expect(match?.canonicalName).toBe('Bakong');
      expect(match?.administrativeType).toBe('district');
    });
  });

  describe('Siem Reap Sangkats', () => {
    it('generates Sangkat Svay Dangkum query', () => {
      const url = formatGoogleMapsUrl('Svay Dangkum', 'siem_reap');
      const decoded = decodeURIComponent(url);
      expect(decoded).toContain('Sangkat Svay Dangkum, Krong Siem Reap, Cambodia');
    });

    it('maps Wat Bo to Sangkat Sla Kram administrative boundary', () => {
      const url = formatGoogleMapsUrl('Wat Bo', 'siem_reap');
      const decoded = decodeURIComponent(url);
      expect(decoded).toContain('Sangkat Sla Kram, Krong Siem Reap, Cambodia');
    });

    it('maps Wat Damnak to Sangkat Sala Kamreuk administrative boundary', () => {
      const url = formatGoogleMapsUrl('Wat Damnak', 'siem_reap');
      const decoded = decodeURIComponent(url);
      expect(decoded).toContain('Sangkat Sala Kamreuk, Krong Siem Reap, Cambodia');
    });

    it('prepends Sangkat on unknown Siem Reap location fallback', () => {
      const url = formatGoogleMapsUrl('Green Village', 'siem_reap');
      const decoded = decodeURIComponent(url);
      expect(decoded).toContain('Sangkat Green Village, Krong Siem Reap, Cambodia');
    });
  });

  describe('Phnom Penh Khans & Sangkats', () => {
    it('maps BKK1 to Sangkat Boeng Keng Kang Ti Muoy', () => {
      const url = formatGoogleMapsUrl('BKK1', 'phnom_penh');
      const decoded = decodeURIComponent(url);
      expect(decoded).toContain('Sangkat Boeng Keng Kang Ti Muoy, Khan Boeng Keng Kang, Phnom Penh');
    });

    it('maps Russian Market / TTP to Sangkat Tuol Tompoung', () => {
      const url = formatGoogleMapsUrl('Russian Market', 'phnom_penh');
      const decoded = decodeURIComponent(url);
      expect(decoded).toContain('Sangkat Tuol Tompoung, Khan Chamkar Mon, Phnom Penh');
    });

    it('maps Daun Penh to Khan Daun Penh', () => {
      const url = formatGoogleMapsUrl('Daun Penh', 'phnom_penh');
      const decoded = decodeURIComponent(url);
      expect(decoded).toContain('Khan Daun Penh, Phnom Penh, Cambodia');
    });
  });

  describe('Direct Maps URL and City Fallbacks', () => {
    it('preserves existing exact maps_url unchanged', () => {
      const exact = 'https://maps.google.com/?q=13.35,103.85';
      const url = formatGoogleMapsUrl('Svay Dangkum', 'siem_reap', exact);
      expect(url).toBe(exact);
    });

    it('falls back to city-level search when location is empty or generic city name', () => {
      const urlEmpty = formatGoogleMapsUrl('', 'siem_reap');
      expect(decodeURIComponent(urlEmpty)).toContain('Siem Reap, Cambodia');

      const urlCity = formatGoogleMapsUrl('Siem Reap', 'siem_reap');
      expect(decodeURIComponent(urlCity)).toContain('Siem Reap, Cambodia');
    });
  });

  describe('Google Maps Coordinate Extractor', () => {
    it('extracts lat and lng from @lat,lng URL pattern', () => {
      const url = 'https://www.google.com/maps/place/Sala+Kamreuk/@13.354123,103.861234,17z/data=...';
      const coords = extractCoordinatesFromMapsUrl(url);
      expect(coords).not.toBeNull();
      expect(coords?.latitude).toBeCloseTo(13.354123, 5);
      expect(coords?.longitude).toBeCloseTo(103.861234, 5);
    });

    it('extracts lat and lng from q=lat,lng URL query pattern', () => {
      const url = 'https://maps.google.com/?q=13.361111,103.855555';
      const coords = extractCoordinatesFromMapsUrl(url);
      expect(coords).not.toBeNull();
      expect(coords?.latitude).toBeCloseTo(13.361111, 5);
      expect(coords?.longitude).toBeCloseTo(103.855555, 5);
    });

    it('returns null for URLs without coordinates', () => {
      expect(extractCoordinatesFromMapsUrl('https://maps.google.com/')).toBeNull();
      expect(extractCoordinatesFromMapsUrl('')).toBeNull();
    });
  });

  describe('Geo Distance & Sanity Bounds', () => {
    it('calculates Haversine distance between coordinates accurately', () => {
      // Distance between Siem Reap city center (13.3611, 103.8596) and Angkor Wat (13.4125, 103.8670) is ~5.7 km
      const dist = calculateDistanceKm(13.3611, 103.8596, 13.4125, 103.867);
      expect(dist).toBeGreaterThan(5.0);
      expect(dist).toBeLessThan(6.5);
    });

    it('accepts coordinates within city sanity bounds', () => {
      // Pub Street area in Siem Reap
      expect(isCoordinateInSanityBounds(13.3541, 103.8556, 'siem_reap')).toBe(true);
      // BKK1 in Phnom Penh
      expect(isCoordinateInSanityBounds(11.5508, 104.9272, 'phnom_penh')).toBe(true);
    });

    it('rejects coordinates inside Lake Tonle Sap', () => {
      // Deep inside Lake Tonle Sap: lat 13.05, lng 103.95
      expect(isCoordinateInSanityBounds(13.05, 103.95, 'siem_reap')).toBe(false);
    });

    it('rejects coordinates exceeding max radius (>25 km from Siem Reap)', () => {
      // 50 km away from Siem Reap
      expect(isCoordinateInSanityBounds(13.8, 103.85, 'siem_reap')).toBe(false);
    });
  });

  describe('3-Way Location Cross-Validation & Consensus', () => {
    it('uses 2-against-1 consensus when text and attribute agree', () => {
      const result = crossValidateLocation('siem_reap', {
        textLocation: 'Svay Dangkum',
        attributeLocation: 'Svay Dangkum',
        pinCoords: { latitude: 13.05, longitude: 103.95 }, // Bogus pin in Tonle Sap
        rawMapsUrl: 'https://maps.google.com/?q=13.05,103.95',
      });

      expect(result.resolvedLocation).toBe('Svay Dangkum');
      expect(result.trustLevel).toBe('text');
      expect(result.isExactPin).toBe(false);
      expect(result.finalMapsUrl).toContain('Sangkat%20Svay%20Dangkum');
      expect(result.finalMapsUrl).not.toContain('13.05');
    });

    it('retains valid exact pin coordinates for URL while keeping text label', () => {
      const validPinUrl = 'https://maps.google.com/?q=13.3541,103.8556';
      const result = crossValidateLocation('siem_reap', {
        textLocation: 'Sala Kamreuk',
        attributeLocation: null,
        pinCoords: { latitude: 13.3541, longitude: 103.8556 },
        rawMapsUrl: validPinUrl,
      });

      expect(result.resolvedLocation).toBe('Sala Kamreuk');
      expect(result.finalMapsUrl).toBe(validPinUrl);
      expect(result.isExactPin).toBe(true);
      expect(result.trustLevel).toBe('pin');
    });

    it('generates specific Google Maps search query for hotel name', () => {
      const result = crossValidateLocation('siem_reap', {
        textLocation: 'Wat Bo',
        hotelName: 'FCC Angkor Boutique Hotel',
      });

      expect(result.resolvedLocation).toBe('Wat Bo');
      expect(result.finalMapsUrl).toContain('FCC%20Angkor%20Boutique%20Hotel%2C%20Siem%20Reap%2C%20Cambodia');
      expect(result.trustLevel).toBe('text');
    });

    it('falls back to city center when no valid location source exists', () => {
      const result = crossValidateLocation('siem_reap', {});
      expect(result.resolvedLocation).toBe('Siem Reap');
      expect(result.trustLevel).toBe('fallback');
      expect(result.finalMapsUrl).toContain('Siem%20Reap%2C%20Cambodia');
    });
  });
});


import { formatGoogleMapsUrl, findCanonicalLocation, extractCoordinatesFromMapsUrl } from '../src/config/locations';

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
});


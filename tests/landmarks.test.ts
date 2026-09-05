import { findLandmarksInText, CAMBODIA_LANDMARKS } from '../src/config/landmarks';

describe('Golden Landmarks Dictionary & Extractor', () => {
  test('contains essential landmarks for Siem Reap and Phnom Penh', () => {
    const srLandmarks = CAMBODIA_LANDMARKS.filter((l) => l.city === 'siem_reap');
    const ppLandmarks = CAMBODIA_LANDMARKS.filter((l) => l.city === 'phnom_penh');

    expect(srLandmarks.length).toBeGreaterThanOrEqual(10);
    expect(ppLandmarks.length).toBeGreaterThanOrEqual(6);

    const ids = CAMBODIA_LANDMARKS.map((l) => l.id);
    expect(ids).toContain('pub_street');
    expect(ids).toContain('road60');
    expect(ids).toContain('apsara_road');
    expect(ids).toContain('russian_market');
    expect(ids).toContain('central_market');
    expect(ids).toContain('aeon_1');
  });

  describe('Siem Reap Landmark Extraction', () => {
    test('detects Pub Street and Old Market in English and Russian', () => {
      const res1 = findLandmarksInText('House 5 mins walk to Pub Street, very quiet.', 'siem_reap');
      expect(res1).toHaveLength(1);
      expect(res1[0].canonicalName).toBe('Pub Street / Old Market');

      const res2 = findLandmarksInText('Студия возле старого рынка (Old market)', 'siem_reap');
      expect(res2).toHaveLength(1);
      expect(res2[0].canonicalName).toBe('Pub Street / Old Market');
    });

    test('detects Road 60 and Ring Road', () => {
      const res1 = findLandmarksInText('Flat house near Road 60 fun fair.', 'siem_reap');
      expect(res1).toHaveLength(1);
      expect(res1[0].canonicalName).toBe('Road 60 (Sokha Road)');

      const res2 = findLandmarksInText('Villa along ring road with wide access.', 'siem_reap');
      expect(res2).toHaveLength(1);
      expect(res2[0].canonicalName).toBe('Ring Road (Siem Reap)');
    });

    test('detects temples and markets (Wat Bo, Angkor Market, Heritage Walk)', () => {
      const resWatBo = findLandmarksInText('Apartment in Wat Bo village near river.', 'siem_reap');
      expect(resWatBo[0].canonicalName).toBe('Wat Bo Temple Area');

      const resAngkor = findLandmarksInText('Modern condo 2 mins to Angkor Market on NR6.', 'siem_reap');
      const names = resAngkor.map((r) => r.canonicalName);
      expect(names).toContain('Angkor Market');
      expect(names).toContain('National Road 6');

      const resHeritage = findLandmarksInText('Close to The Heritage Walk shopping mall.', 'siem_reap');
      expect(resHeritage[0].canonicalName).toBe('The Heritage Walk');
    });

    test('detects Khmer script landmark names', () => {
      const resKhmer = findLandmarksInText('ផ្ទះជួលជិត ផ្សារលើធំថ្មី ក្រុងសៀមរាប', 'siem_reap');
      expect(resKhmer).toHaveLength(1);
      expect(resKhmer[0].canonicalName).toBe('Phsar Leu Market');
    });
  });

  describe('Phnom Penh Landmark Extraction', () => {
    test('detects Russian Market / TTP', () => {
      const resTTP = findLandmarksInText('Cosy apartment in TTP near Russian Market.', 'phnom_penh');
      expect(resTTP[0].canonicalName).toBe('Russian Market (Toul Tom Poung)');
    });

    test('detects Aeon 1 and Riverside', () => {
      const resAeon = findLandmarksInText('Condo with river view 5 mins to Aeon 1 mall.', 'phnom_penh');
      expect(resAeon[0].canonicalName).toBe('Aeon Mall 1 (Tonle Bassac)');

      const resRiverside = findLandmarksInText('Luxury apartment on Sisowath Quay Riverside.', 'phnom_penh');
      expect(resRiverside[0].canonicalName).toBe('Riverside (Sisowath Quay)');
    });

    test('detects Central Market (Phsar Thmey)', () => {
      const resCentral = findLandmarksInText('Apartment near Central Market in Daun Penh.', 'phnom_penh');
      expect(resCentral[0].canonicalName).toBe('Central Market (Phsar Thmey)');
    });
  });

  test('returns empty array when no known landmarks are mentioned', () => {
    const res = findLandmarksInText('Generic apartment with 2 bedrooms and swimming pool.', 'siem_reap');
    expect(res).toEqual([]);
  });
});

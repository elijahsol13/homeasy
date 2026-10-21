import { extractPropertyMapUrlFromText, resolvePropertyMapFromText } from '../src/modules/parser/source-map-location';

const shortUrl = 'https://maps.app.goo.gl/example123';
const selectedPlaceUrl = 'https://www.google.com/maps/place/Example/@13.352345,103.865432,17z/data=!3m1!4b1!4m6!3m5!1sabc!8m2!3d13.352345!4d103.865432';

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe('source-labelled Google Maps locations', () => {
  test.each([
    [`Location: ${shortUrl}`, shortUrl],
    [`🟢Location: ${shortUrl}`, shortUrl],
    [`📍 Address: ${shortUrl}`, shortUrl],
    [`Property address: ${shortUrl}`, shortUrl],
    [`ទីតាំង: ${shortUrl}`, shortUrl],
    [`See location on Google Map: ${shortUrl}`, shortUrl],
    [`Location:\n${shortUrl}`, shortUrl],
  ])('recognizes an explicit property map label', (text, expected) => {
    expect(extractPropertyMapUrlFromText(text)).toBe(expected);
  });

  test.each([
    `5 minutes to Pub Street ${shortUrl}`,
    `Near Old Market: ${shortUrl}`,
    `Only a map link: ${shortUrl}`,
    `Around 2 km from Angkor Wat ${shortUrl}`,
  ])('does not treat proximity or unlabeled maps as a property pin: %s', text => {
    expect(extractPropertyMapUrlFromText(text)).toBeNull();
  });

  it('resolves a labelled Google shortlink to the selected place pin', async () => {
    const fetchImpl = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(redirect(selectedPlaceUrl))
      .mockResolvedValueOnce(new Response(''));
    const result = await resolvePropertyMapFromText(`Property location: ${shortUrl}`, 'siem_reap', fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({
      sourceUrl: shortUrl,
      mapsUrl: selectedPlaceUrl,
      latitude: 13.352345,
      longitude: 103.865432,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, shortUrl, expect.objectContaining({ redirect: 'manual' }));
  });

  it('does not follow a Google shortlink redirect to another host', async () => {
    const fetchImpl = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>().mockResolvedValueOnce(
      redirect('https://attacker.example/maps/place/@13.352345,103.865432'),
    );
    const result = await resolvePropertyMapFromText(`Location: ${shortUrl}`, 'siem_reap', fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ sourceUrl: shortUrl, mapsUrl: shortUrl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps a labelled link for navigation but does not accept camera centres, coarse links or another city', async () => {
    const camera = 'https://www.google.com/maps/@13.352345,103.865432,17z';
    await expect(resolvePropertyMapFromText(`Location: ${camera}`, 'siem_reap'))
      .resolves.toEqual({ sourceUrl: camera, mapsUrl: camera });
    const outside = 'https://www.google.com/maps/place/Example/data=!3d11.556400!4d104.928200';
    await expect(resolvePropertyMapFromText(`Address: ${outside}`, 'siem_reap'))
      .resolves.toEqual({ sourceUrl: outside, mapsUrl: outside });
  });
});

const API_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

export type Coords = { lat: number; lng: number };

/**
 * Geocode a human-readable address string using Google Geocoding API.
 * Throws a descriptive error if no result is found or if the API key is missing.
 */
export async function geocodeAddress(address: string): Promise<Coords> {
  if (!API_KEY) {
    throw new Error(
      '[Geocoding] EXPO_PUBLIC_GOOGLE_MAPS_API_KEY is not set. ' +
      'Add it to .env and restart with: npx expo start --clear',
    );
  }

  const url =
    `https://maps.googleapis.com/maps/api/geocode/json` +
    `?address=${encodeURIComponent(address)}&key=${encodeURIComponent(API_KEY)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[Geocoding] HTTP ${res.status} for address: ${address}`);
  }

  const json = await res.json();

  if (json.status !== 'OK' || !json.results?.length) {
    throw new Error(
      `[Geocoding] No results for "${address}" (status: ${json.status})`,
    );
  }

  const { lat, lng } = json.results[0].geometry.location;
  return { lat, lng };
}

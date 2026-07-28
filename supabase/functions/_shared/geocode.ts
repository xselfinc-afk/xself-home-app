// Single canonical server-side geocoder (Google Maps Geocoding API). Shared by plan-fulfillment
// (checkout) and fulfillment-eligibility (PDP/Cart advisory) so there is ONE geocoding pipeline.
// The API key is passed in by the caller (from GOOGLE_MAPS_API_KEY) — this module reads no env.

export interface Coords {
  lat: number;
  lng: number;
}

/** Geocode a free-text address to lat/lng. Throws on missing key, HTTP error, or no result
 *  (callers treat a throw as "location unknown" and fail conservatively — never as unavailable). */
export async function geocodeAddress(address: string, apiKey: string): Promise<Coords> {
  if (!apiKey) {
    throw new Error('GOOGLE_MAPS_API_KEY not configured — run: supabase secrets set GOOGLE_MAPS_API_KEY=<key>');
  }
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'OK' || !json.results?.length) {
    throw new Error(`Geocoding failed (${json.status}) for: "${address}"`);
  }
  return json.results[0].geometry.location as Coords;
}

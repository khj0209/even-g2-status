import type { Unit } from './types';

export const KMH_PER_MPS = 3.6;
const KM_PER_MILE = 1.609344;

/** Speed for display in the chosen unit, rounded; GPS jitter under ~2 km/h reads as 0. */
export function displaySpeed(mps: number, unit: Unit): number {
  const kmh = mps * KMH_PER_MPS;
  if (kmh < 2) return 0;
  return Math.round(unit === 'mph' ? kmh / KM_PER_MILE : kmh);
}

/** Speed limits are stored in km/h; convert for display. */
export function displayLimit(kmh: number, unit: Unit): number {
  return unit === 'mph' ? Math.round(kmh / KM_PER_MILE / 5) * 5 : kmh;
}

export const unitLabel = (unit: Unit) => (unit === 'mph' ? 'mph' : 'km/h');

/** "40 m", "350 m", "1.2 km", "14 km" (or ft / mi). Rounded coarsely so the text does not flicker. */
export function formatDistance(m: number, unit: Unit): string {
  if (unit === 'mph') {
    const mi = m / 1000 / KM_PER_MILE;
    if (mi < 0.1) return `${Math.max(50, Math.round((m * 3.28084) / 50) * 50)} ft`;
    return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
  }
  if (m < 1000) {
    const step = m < 100 ? 10 : 50;
    return `${Math.max(step, Math.round(m / step) * step)} m`;
  }
  const km = m / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

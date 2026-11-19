export interface LatLon {
  lat: number;
  lon: number;
}

/** One position fix. `speed` is m/s, `heading` is degrees clockwise from north. */
export interface Fix extends LatLon {
  speed: number | null;
  heading: number | null;
  accuracy?: number;
  ts: number;
  /** Not measured: extrapolated along the road while GPS is lost (tunnels, underpasses). */
  estimated?: boolean;
}

export type Unit = 'kmh' | 'mph';

export interface Settings {
  unit: Unit;
  /** km/h over the limit before the overspeed warning shows. */
  overspeedTolerance: number;
  cameraAlerts: boolean;
  demo: boolean;
  /** Personal Tmap(SK open api) appKey. Empty string falls back to OSRM/Nominatim. */
  tmapApiKey: string;
  /** Dim the HUD at night: automatically after dusk, or always bright/dim. */
  nightMode: 'auto' | 'day' | 'night';
  /** Saved destinations, started from the glasses menu. */
  home: SavedPlace | null;
  work: SavedPlace | null;
  /** Experimental drowsiness warning from the glasses' motion sensor. */
  drowsy: { enabled: boolean; cal: { axis: 0 | 1 | 2; sign: 1 | -1; amp: number } | null };
}

export interface SavedPlace extends LatLon {
  name: string;
}

export const DEFAULT_SETTINGS: Settings = {
  unit: 'kmh',
  overspeedTolerance: 0,
  cameraAlerts: true,
  demo: false,
  tmapApiKey: '',
  nightMode: 'auto',
  home: null,
  work: null,
  drowsy: { enabled: false, cal: null },
};

export type ManeuverIcon =
  | 'straight'
  | 'slight-left'
  | 'left'
  | 'sharp-left'
  | 'slight-right'
  | 'right'
  | 'sharp-right'
  | 'uturn'
  | 'roundabout'
  | 'arrive';

export interface NavProgress {
  icon: ManeuverIcon;
  /** Metres to the next manoeuvre. */
  distToManeuver: number;
  /** Road entered after the manoeuvre (may be empty). */
  roadName: string;
  remainingDist: number;
  /** Seconds. */
  remainingTime: number;
}

export interface CameraAlert {
  dist: number;
  /** km/h, if tagged. */
  limit: number | null;
  /** 0 speed, 1 section start, 2 section end, 3 signal (see tileformat CAM_*). */
  kind?: number;
}

/** Inside a section speed check (구간단속). */
export interface SectionStatus {
  /** km/h. */
  limit: number | null;
  /** Average speed since the start camera, km/h. */
  avgKmh: number;
  /** Metres to the end camera, if the section length is known. */
  remaining: number | null;
}

/** A point in minimap pixels relative to the car (x right, y down), heading-up rotated if known. */
export interface MinimapPoint {
  x: number;
  y: number;
}

export interface MinimapView {
  /** Metres per pixel; zooms out with speed. */
  scale: number;
  /** Building outlines in view (closed polygons). */
  buildings: MinimapPoint[][];
  /** Surrounding roads, clipped to the view. Major roads are drawn heavier. */
  roads: { major: boolean; points: MinimapPoint[] }[];
  /** Active route near the car (empty when not navigating). */
  route: MinimapPoint[];
  /** Next manoeuvre point, if it is in view. */
  turn: MinimapPoint | null;
  /** Destination, if it is in view. */
  dest: MinimapPoint | null;
  /** Speed cameras in view. */
  cameras: MinimapPoint[];
  /** Whether rotation is heading-up (true) or plain north-up because heading is unknown (false). */
  headingKnown: boolean;
  /** Changes whenever the picture would: car position to about a pixel, heading, zoom and map data. */
  key: string;
}

/** The whole route, north-up, fitted into the overview box (pixels from its top-left). */
export interface OverviewView {
  /** Route already driven (drawn dim) and still ahead (bright). */
  done: MinimapPoint[];
  ahead: MinimapPoint[];
  car: MinimapPoint | null;
  /** Direction of travel, degrees clockwise from north; null if unknown. */
  heading: number | null;
  dest: MinimapPoint;
  /** Changes whenever the picture would. */
  key: string;
}

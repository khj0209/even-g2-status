import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { isDark } from './core/sun';
import { DEFAULT_SETTINGS, type Fix, type LatLon, type NavProgress, type SavedPlace, type Settings } from './core/types';
import { GlassesSink, type GlassesMenuItem } from './hud/glasses';
import { HudRenderer, type HudSink } from './hud/renderer';
import { buildView, LimitFilter, type HudView } from './hud/view';
import { demoRoadData, demoRoute } from './services/demo';
import { DrowsinessDetector, DrowsyCalibrator } from './services/drowsiness';
import {
  BridgeLocationSource,
  BrowserLocationSource,
  DemoLocationSource,
  FixNormalizer,
  type LocationSource,
} from './services/location';
import { deadReckon, DR_START_MS, MapMatcher, type PathRef } from './services/matching';
import { RoadDataService } from './services/mapcache';
import { SectionTracker } from './services/section';
import { TmapLimitService } from './services/tmaplimit';
import { MAX_TRIPS, TripRecorder, type Trip } from './services/trip';
import { CameraTracker, matchLimit, type RoadData } from './services/roads';
import { fetchRoute, RouteTracker, type Place } from './services/routing';

const SETTINGS_KEY = 'drivehud.settings';
/** A fix older than this is treated as "no GPS". */
const STALE_MS = 5000;
/** With GPS gone and nothing to extrapolate (stopped, or no heading), keep the last place this long. */
const HOLD_MS = 60000;
/** Keep showing the last turn instruction this long through a gap in guidance. */
const NAV_HOLD_MS = 15000;
const REROUTE_INTERVAL_MS = 10000;
const TRIPS_KEY = 'drivehud.trips';
/** While guiding with Tmap, look for a faster route (traffic) this often. */
const TRAFFIC_CHECK_MS = 5 * 60 * 1000;
/** Switch only for a real gain: at least 3 minutes and 10% of the time left. */
const TRAFFIC_MIN_SAVING_S = 180;
const CALIBRATION_MS = 4000;

const MENU: GlassesMenuItem[] = [
  { id: 1, name: '집으로' },
  { id: 2, name: '회사로' },
  { id: 3, name: '안내 종료' },
  { id: 4, name: '운전 모드 끝내기' },
];

export interface AppState {
  view: HudView;
  settings: Settings;
  glasses: boolean;
  gps: boolean;
  destination: Place | null;
  /** Last known position (even if stale), to bias destination search towards. */
  position: LatLon | null;
  /** Human-readable navigation status / error for the phone page. */
  navMessage: string;
  /** Map data status for the phone page. */
  mapStatus: string;
  currentTrip: Trip | null;
  trips: Trip[];
  /** Drowsiness warning status for the phone page. */
  drowsyStatus: string;
  /** What kept running while the phone screen was last off. */
  backgroundReport: string;
}

export class App {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private bridge: EvenAppBridge | null = null;
  private glasses: GlassesSink | null = null;
  private renderer = new HudRenderer();
  private source: LocationSource | null = null;
  private normalizer = new FixNormalizer();
  private matcher = new MapMatcher();
  private cameras = new CameraTracker();
  private lastNav: { nav: NavProgress; at: number } | null = null;
  /** The road the last fix was matched to, and whether that just changed (for the limit sign). */
  private matchedRoad: unknown = null;
  private roadChanged = false;
  private tmapLimits = new TmapLimitService();
  /** Where the last real fix was matched on the map, for dead reckoning through tunnels. */
  private lastRef: PathRef | null = null;
  private roadPaths: { data: RoadData | null; paths: ReturnType<typeof roadPaths> } = { data: null, paths: [] };
  private roads = new RoadDataService();
  private limitFilter = new LimitFilter();
  private tracker: RouteTracker | null = null;
  private destination: Place | null = null;
  private navMessage = '';
  private fix: Fix | null = null;
  private lastReroute = 0;
  private trips: Trip[] = [];
  private tripRecorder = new TripRecorder((t) => {
    this.saveTrip(t);
    this.tripEndListeners.forEach((fn) => fn(t));
  });
  /** G2 Status: driving mode runs only between startDriving() and stopDriving(). */
  private running = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private onExit: (() => void) | null = null;
  private tripEndListeners: ((t: Trip) => void)[] = [];
  private section = new SectionTracker();
  private flashMsg: { text: string; until: number } | null = null;
  private lastTrafficCheck = 0;
  private trafficBusy = false;
  private drowsy: DrowsinessDetector | null = null;
  private calibrator: DrowsyCalibrator | null = null;
  private imu = { count: 0, since: 0, last: [0, 0, 0] as number[] };
  /** Counts while the phone screen was off, to see what keeps running in the background. */
  private counters = { fixes: 0, ticks: 0 };
  private hiddenAt: { at: number; snap: ReturnType<App['snapshot']> } | null = null;
  private backgroundReport = '';
  private listeners: ((s: AppState) => void)[] = [];

  /** `forceDemo` pins demo mode on regardless of saved settings (the `?demo` URL flag). */
  constructor(
    preview: HudSink,
    private forceDemo = false,
  ) {
    this.renderer.addSink(preview);
    this.loadSettings(localStorage.getItem(SETTINGS_KEY));
    this.loadTrips(localStorage.getItem(TRIPS_KEY));
  }

  /** Lay out the phone preview. Location and the glasses only start with startDriving(). */
  start(): void {
    this.renderer.start();
    this.tick();
  }

  get driving(): boolean {
    return this.running;
  }

  /** A trip ended (stopped for a while): G2 Status uses this to leave an automatic driving mode. */
  onTripEnd(fn: (t: Trip) => void): void {
    this.tripEndListeners.push(fn);
  }

  /**
   * Take over the glasses and start GPS. `onExit` is called when the wearer asks to leave
   * (double tap or the "운전 모드 끝내기" menu item).
   */
  startDriving(onExit: () => void): void {
    if (this.running) return;
    this.running = true;
    this.onExit = onExit;
    this.renderer.start();
    if (this.bridge) {
      this.glasses = new GlassesSink(
        this.bridge,
        {
          onDoubleClick: () => this.onExit?.(),
          onResume: () => this.renderer.redraw(),
          onMenu: (id) => this.onMenu(id),
          onImu: (v) => this.onImu(v),
        },
        MENU,
        { pageExists: true },
      );
      this.renderer.addSink(this.glasses);
      this.applyDrowsy();
    }
    this.restartLocation();
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  /** Give the glasses back and stop GPS. The trip in progress is closed and kept. */
  stopDriving(): void {
    if (!this.running) return;
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.source?.stop();
    this.source = null;
    this.tripRecorder.finish();
    if (this.glasses) {
      void this.glasses.setImu(false);
      this.renderer.removeSink(this.glasses);
      this.glasses.dispose();
      this.glasses = null;
    }
    this.onExit = null;
    this.tick();
  }

  /** Called once the Even App bridge is up: load saved settings/trips. Glasses attach in startDriving(). */
  async attachBridge(bridge: EvenAppBridge): Promise<void> {
    this.bridge = bridge;
    this.loadSettings(await bridge.getLocalStorage(SETTINGS_KEY).catch(() => ''));
    this.loadTrips(await bridge.getLocalStorage(TRIPS_KEY).catch(() => ''));
    if (this.running) this.restartLocation();
    this.tick();
  }


  private snapshot() {
    return {
      ...this.counters,
      images: this.glasses?.sent.images ?? 0,
      texts: this.glasses?.sent.texts ?? 0,
      failed: this.glasses?.sent.failed ?? 0,
      downloads: this.roads.downloads,
    };
  }

  /** Phone screen off/on (page hidden/visible): report what ran while it was off. */
  setVisible(visible: boolean): void {
    if (!visible) {
      this.hiddenAt = { at: Date.now(), snap: this.snapshot() };
      return;
    }
    if (!this.hiddenAt) return;
    const secs = Math.round((Date.now() - this.hiddenAt.at) / 1000);
    const a = this.hiddenAt.snap;
    const b = this.snapshot();
    this.hiddenAt = null;
    if (secs < 10) return;
    this.backgroundReport =
      `화면 꺼짐 ${secs}초 동안: 위치 ${b.fixes - a.fixes}회 · 화면 갱신 ${b.ticks - a.ticks}회 · ` +
      `글래스 이미지 ${b.images - a.images}회 · 글자 ${b.texts - a.texts}회` +
      (b.failed - a.failed ? ` (실패 ${b.failed - a.failed})` : '') +
      ` · 지도 받기 ${b.downloads - a.downloads}회`;
    this.tick();
  }

  onState(fn: (s: AppState) => void): void {
    this.listeners.push(fn);
  }

  updateSettings(patch: Partial<Settings>): void {
    const demoChanged = patch.demo != null && patch.demo !== this.settings.demo;
    this.settings = { ...this.settings, ...patch };
    if (patch.drowsy) this.applyDrowsy();
    const json = JSON.stringify(this.settings);
    localStorage.setItem(SETTINGS_KEY, json);
    void this.bridge?.setLocalStorage(SETTINGS_KEY, json);
    if (demoChanged && this.running) this.restartLocation();
    this.tick();
  }

  async navigateTo(place: Place): Promise<void> {
    if (this.settings.demo) return;
    if (!this.fix) {
      this.navMessage = 'GPS 신호를 기다리는 중입니다';
      this.tick();
      return;
    }
    this.destination = place;
    this.navMessage = '경로 탐색 중…';
    this.tick();
    try {
      this.tracker = new RouteTracker(await fetchRoute(this.fix, place, this.settings.tmapApiKey));
      this.navMessage = '';
      this.lastTrafficCheck = Date.now();
      // Fetch the map along the whole route now, while there's signal, so tunnels and server
      // hiccups on the way don't leave gaps.
      this.roads.prefetchRoute(this.tracker.route.points);
    } catch (e) {
      this.tracker = null;
      this.navMessage = e instanceof Error ? e.message : String(e);
      this.flash(this.navMessage);
    }
    this.tick();
  }

  /** Save a search result as home or work, for the glasses menu. */
  savePlace(which: 'home' | 'work', place: SavedPlace | null): void {
    this.updateSettings({ [which]: place && { name: place.name, lat: place.lat, lon: place.lon } });
  }

  /** The glasses' menu: start guidance home / to work, or stop guiding, without touching the phone. */
  private onMenu(id: number): void {
    if (id === 4) {
      this.onExit?.();
      return;
    }
    if (id === 3) {
      this.stopNavigation();
      this.flash('안내를 종료했습니다');
      return;
    }
    const place = id === 1 ? this.settings.home : id === 2 ? this.settings.work : null;
    const [object, toward] = id === 1 ? ['집을', '집으로'] : ['회사를', '회사로'];
    if (!place) this.flash(`휴대폰에서 ${object} 먼저 등록하세요`);
    else {
      this.flash(`${toward} 경로 탐색 중…`);
      void this.navigateTo(place);
    }
  }

  /** Show a short message in the glasses' info line for a while. */
  private flash(text: string, ms = 4000): void {
    this.flashMsg = { text, until: Date.now() + ms };
    this.tick();
  }

  // --- Trips ----------------------------------------------------------------------------------

  private loadTrips(json: string | null): void {
    try {
      if (json) this.trips = JSON.parse(json);
    } catch {
      /* keep what we have */
    }
  }

  private saveTrip(t: Trip): void {
    this.trips = [t, ...this.trips].slice(0, MAX_TRIPS);
    this.storeTrips();
  }

  /** The page is going away: close the trip in progress so it's kept. */
  shutdown(): void {
    this.tripRecorder.finish();
  }

  clearTrips(): void {
    this.trips = [];
    this.storeTrips();
    this.tick();
  }

  private storeTrips(): void {
    const json = JSON.stringify(this.trips);
    localStorage.setItem(TRIPS_KEY, json);
    void this.bridge?.setLocalStorage(TRIPS_KEY, json);
  }

  // --- Drowsiness (experimental) -----------------------------------------------------------------

  /** Turn the glasses' motion sensor on while it's needed (warning enabled, or calibrating). */
  private applyDrowsy(): void {
    const { enabled, cal } = this.settings.drowsy;
    this.drowsy = enabled && cal ? new DrowsinessDetector(cal) : null;
    void this.glasses?.setImu(!!this.drowsy || !!this.calibrator);
  }

  /** Parked, the wearer looks ahead, presses this and nods twice within 4 seconds. */
  calibrateDrowsy(): void {
    if (!this.glasses) {
      this.navMessage = '글래스가 연결되어 있어야 보정할 수 있습니다';
      this.tick();
      return;
    }
    this.calibrator = new DrowsyCalibrator();
    this.applyDrowsy();
    this.flash('고개를 두 번 끄덕이세요', CALIBRATION_MS);
    setTimeout(() => {
      const cal = this.calibrator?.finish() ?? null;
      this.calibrator = null;
      this.navMessage = cal ? '졸음 감지 보정 완료' : '보정 실패: 글래스 움직임 센서 값이 오지 않았습니다';
      if (cal) this.updateSettings({ drowsy: { ...this.settings.drowsy, cal } });
      else this.applyDrowsy();
      this.tick();
    }, CALIBRATION_MS);
  }

  private onImu(v: [number, number, number]): void {
    const now = Date.now();
    if (now - this.imu.since > 5000) this.imu = { count: 0, since: now, last: v };
    this.imu.count++;
    this.imu.last = v;
    if (this.calibrator) {
      this.calibrator.add(v);
      return;
    }
    const kmh = (this.fix?.speed ?? 0) * 3.6;
    if (this.drowsy?.sample(v, now, kmh)) {
      this.flash('졸음 주의 · 쉬어 가세요', 10000);
      navigator.vibrate?.([400, 200, 400]);
    }
  }

  private drowsyStatus(): string {
    const { enabled, cal } = this.settings.drowsy;
    if (this.calibrator) return `보정 중… (센서 값 ${this.calibrator.count}개)`;
    const rate = this.imu.since ? (this.imu.count / Math.max(1, (Date.now() - this.imu.since) / 1000)).toFixed(1) : '0';
    const live = this.drowsy ? ` · 센서 ${rate}회/초 [${this.imu.last.map((x) => x.toFixed(2)).join(', ')}]` : '';
    if (!cal) return '보정 필요';
    return `${enabled ? '켜짐' : '꺼짐'} · 축 ${'xyz'[cal.axis]}${live}`;
  }

  // --- Traffic -----------------------------------------------------------------------------------

  /** With Tmap, look for a faster route every few minutes and switch if it saves real time. */
  private checkFasterRoute(fix: Fix, nav: NavProgress | null): void {
    const now = Date.now();
    if (!this.tracker || !this.destination || !nav || fix.estimated || this.settings.demo) return;
    if (!this.settings.tmapApiKey || this.trafficBusy || now - this.lastTrafficCheck < TRAFFIC_CHECK_MS) return;
    this.lastTrafficCheck = now;
    this.trafficBusy = true;
    const dest = this.destination;
    fetchRoute(fix, dest, this.settings.tmapApiKey)
      .then((route) => {
        const saving = nav.remainingTime - route.duration;
        if (this.destination !== dest || saving < TRAFFIC_MIN_SAVING_S || saving < 0.1 * nav.remainingTime) return;
        this.tracker = new RouteTracker(route);
        this.roads.prefetchRoute(route.points);
        this.flash(`더 빠른 길로 변경 · ${Math.round(saving / 60)}분 단축`, 8000);
      })
      .catch((e) => console.warn('[traffic]', e))
      .finally(() => (this.trafficBusy = false));
  }

  /** Download the map within 3 km of the current position for later use. */
  prefetchHere(): void {
    if (this.settings.demo || !this.fix) {
      this.navMessage = this.settings.demo ? '데모 주행 중에는 지도를 받지 않습니다' : 'GPS 신호를 기다리는 중입니다';
    } else this.roads.prefetchArea(this.fix, 3000);
    this.tick();
  }

  async clearStoredMap(): Promise<void> {
    await this.roads.clearStored();
    this.tick();
  }

  stopNavigation(message = ''): void {
    this.tracker = null;
    this.destination = null;
    this.navMessage = message;
    this.tick();
  }

  private loadSettings(json: string | null): void {
    try {
      if (json) this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(json) };
    } catch {
      /* corrupt settings: keep defaults */
    }
    if (this.forceDemo) this.settings.demo = true;
  }

  private restartLocation(): void {
    this.source?.stop();
    this.fix = null;
    this.normalizer = new FixNormalizer();
    this.matcher = new MapMatcher();
    this.lastRef = null;
    this.cameras = new CameraTracker();
    this.lastNav = null;
    this.tripRecorder.finish();
    this.section = new SectionTracker();
    this.limitFilter = new LimitFilter();
    this.roads = new RoadDataService();
    this.tracker = null;
    this.destination = null;
    this.navMessage = '';
    if (this.settings.demo) {
      this.roads.data = demoRoadData();
      this.tracker = new RouteTracker(demoRoute());
      this.source = new DemoLocationSource();
    } else {
      this.source = this.bridge ? new BridgeLocationSource(this.bridge) : new BrowserLocationSource();
    }
    this.source.start((raw) => {
      this.counters.fixes++;
      const fix = this.normalizer.next(raw);
      if (!fix) return; // skipped: inaccurate, duplicate or a glitch
      this.fix = this.matcher.snap(fix, this.tracker?.route.points ?? null, this.mapPaths());
      this.lastRef = this.matcher.last;
      if (this.matcher.road && this.matcher.road !== this.matchedRoad) this.roadChanged = true;
      if (this.matcher.road) this.matchedRoad = this.matcher.road;
      if (!this.settings.demo) this.tmapLimits.update(this.fix, this.settings.tmapApiKey, this.matcher.road);
      this.tick();
    });
  }

  /** Minimap road polylines, rebuilt only when new map data arrives. */
  private mapPaths() {
    if (this.roadPaths.data !== this.roads.data) this.roadPaths = { data: this.roads.data, paths: roadPaths(this.roads.data) };
    return this.roadPaths.paths;
  }

  private trackRoute(fix: Fix): NavProgress | null {
    if (!this.tracker) return null;
    const result = this.tracker.update(fix);
    if (result.state === 'guiding') return result.progress;
    // An estimated position drifting off the route is no reason to reroute or announce arrival.
    if (fix.estimated) return null;
    if (this.settings.demo) {
      this.tracker = new RouteTracker(demoRoute()); // loop the demo drive
    } else if (result.state === 'arrived') {
      this.stopNavigation('목적지에 도착했습니다');
    } else if (this.destination && Date.now() - this.lastReroute > REROUTE_INTERVAL_MS) {
      this.lastReroute = Date.now();
      void this.navigateTo(this.destination);
    }
    return null;
  }

  /**
   * The position to show: the last real fix while it is recent; then, if GPS has gone quiet while
   * driving (tunnel, underpass), an estimate along the road; otherwise nothing once it is stale.
   */
  private currentFix(now: number): Fix | null {
    if (!this.fix) return null;
    const age = now - this.fix.ts;
    if (age < DR_START_MS) return this.fix;
    const dr = deadReckon(this.fix, this.lastRef, age, now);
    if (dr) return dr;
    if (age < STALE_MS) return this.fix;
    // Stopped (at lights, in a car park) or nothing to follow: a car that isn't moving hasn't gone
    // anywhere, so keep the last place rather than blanking the HUD.
    if (age < HOLD_MS) return { ...this.fix, estimated: true };
    return null;
  }

  private tick(): void {
    this.counters.ticks++;
    const now = new Date();
    const fix = this.currentFix(now.getTime());
    let limit: number | null = null;
    let camera = null;
    let nav = null;
    if (fix) {
      if (!this.settings.demo) this.roads.update(fix);
      // Tmap's limit (if a key is set and it has one here) over OpenStreetMap's: it's what Korean
      // navigation uses and far more complete.
      const tmap = this.settings.demo ? null : this.tmapLimits.limitAt(fix);
      limit = this.limitFilter.next(tmap ?? matchLimit(this.roads.data, fix), this.roadChanged && !fix.estimated);
      this.roadChanged = false;
      camera = this.cameras.next(this.roads.data, fix, fix.estimated ? null : this.lastRef);
      nav = this.trackRoute(fix);
    } else limit = this.limitFilter.current;
    // Ride out short gaps in guidance (a stray fix off the route, GPS dropping out).
    const t = now.getTime();
    if (nav) this.lastNav = { nav, at: t };
    else if (this.tracker && this.lastNav && t - this.lastNav.at < NAV_HOLD_MS) nav = this.lastNav.nav;
    let section = null;
    if (fix) {
      this.tripRecorder.update(fix);
      section = this.section.update(fix, this.tripRecorder.odometer, this.roads.data);
      if (!fix.estimated) this.checkFasterRoute(fix, nav);
    }
    const flash = this.flashMsg && this.flashMsg.until > t ? this.flashMsg.text : null;
    const where = fix ?? this.fix ?? { lat: 37.5, lon: 127 };
    const dim = this.settings.nightMode === 'night' || (this.settings.nightMode === 'auto' && isDark(now, where));
    const view = buildView({
      fix,
      limit,
      camera,
      nav,
      route: this.tracker?.route ?? null,
      roads: this.roads.data,
      section,
      flash,
      dim,
      settings: this.settings,
      now,
    });
    this.renderer.render(view);
    const state: AppState = {
      view,
      settings: this.settings,
      glasses: !!this.glasses,
      gps: !!fix && !fix.estimated,
      destination: this.destination,
      position: this.fix && { lat: this.fix.lat, lon: this.fix.lon },
      navMessage: this.navMessage,
      currentTrip: this.tripRecorder.current,
      trips: this.trips,
      drowsyStatus: this.drowsyStatus(),
      backgroundReport: this.backgroundReport,
      mapStatus: this.settings.demo
        ? '지도: 데모 데이터'
        : `지도: ${this.roads.statusText()}${this.settings.tmapApiKey ? ` · ${this.tmapLimits.statusText()}` : ''}`,
    };
    for (const fn of this.listeners) fn(state);
  }
}

const roadPaths = (data: RoadData) => data.map.map((w) => w.points);

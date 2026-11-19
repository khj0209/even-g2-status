import type { App, AppState } from './app';
import type { LatLon, Settings, Unit } from './core/types';
import type { Trip } from './services/trip';
import { searchPlaces, type Place } from './services/routing';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Wire the Drive HUD's phone controls (ported from the Drive HUD app) to `app`. */
export function initDriveUi(app: App): void {

  const unit = $<HTMLSelectElement>('set-unit');
  const tolerance = $<HTMLSelectElement>('set-tolerance');
  const camera = $<HTMLInputElement>('set-camera');
  const demo = $<HTMLInputElement>('set-demo');
  const tmapKey = $<HTMLInputElement>('set-tmap-key');
  const results = $<HTMLUListElement>('results');
  const searchInput = $<HTMLInputElement>('search-input');
  const searchMessage = $('nav-message');

  unit.onchange = () => app.updateSettings({ unit: unit.value as Unit });
  tolerance.onchange = () => app.updateSettings({ overspeedTolerance: Number(tolerance.value) });
  camera.onchange = () => app.updateSettings({ cameraAlerts: camera.checked });
  demo.onchange = () => app.updateSettings({ demo: demo.checked });
  tmapKey.onchange = () => app.updateSettings({ tmapApiKey: tmapKey.value.trim() });
  $('nav-stop').onclick = () => app.stopNavigation();
  const night = $<HTMLSelectElement>('set-night');
  night.onchange = () => app.updateSettings({ nightMode: night.value as Settings['nightMode'] });
  const drowsy = $<HTMLInputElement>('set-drowsy');
  drowsy.onchange = () => app.updateSettings({ drowsy: { ...app.settings.drowsy, enabled: drowsy.checked } });
  $('drowsy-calibrate').onclick = () => app.calibrateDrowsy();
  $('home-go').onclick = () => app.settings.home && void app.navigateTo(app.settings.home);
  $('work-go').onclick = () => app.settings.work && void app.navigateTo(app.settings.work);
  $('home-clear').onclick = () => app.savePlace('home', null);
  $('work-clear').onclick = () => app.savePlace('work', null);
  $('trip-clear').onclick = () => {
    if (confirm('주행 기록을 모두 지울까요?')) app.clearTrips();
  };
  addEventListener('pagehide', () => app.shutdown());
  document.addEventListener('visibilitychange', () => app.setVisible(document.visibilityState === 'visible'));
  $('map-prefetch').onclick = () => app.prefetchHere();
  $('map-clear').onclick = () => {
    if (confirm('저장된 지도를 모두 지울까요?')) void app.clearStoredMap();
  };

  let lastPosition: LatLon | null = null;
  let searchError = '';

  function button(text: string, cls: string, onclick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.className = cls;
    b.onclick = onclick;
    return b;
  }

  function showResults(places: Place[]): void {
    results.replaceChildren(
      ...places.map((place) => {
        const li = document.createElement('li');
        li.append(
          button(place.name, 'place', () => {
            results.replaceChildren();
            void app.navigateTo(place);
          }),
          button('집', 'small', () => app.savePlace('home', place)),
          button('회사', 'small', () => app.savePlace('work', place)),
        );
        return li;
      }),
    );
  }

  const fmtKm = (m: number) => `${(m / 1000).toFixed(1)} km`;
  const fmtMin = (ms: number) => `${Math.round(ms / 60000)}분`;
  function tripText(t: Trip): string {
    const avg = t.movingMs > 0 ? Math.round(t.distance / (t.movingMs / 1000) * 3.6) : 0;
    return `${fmtKm(t.distance)} · ${fmtMin(t.end - t.start)} · 평균 ${avg} km/h · 최고 ${Math.round(t.maxKmh)} km/h`;
  }
  function tripDate(t: Trip): string {
    const d = new Date(t.start);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  $<HTMLFormElement>('search-form').onsubmit = async (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;
    searchError = '검색 중…';
    searchMessage.textContent = searchError;
    try {
      const places = await searchPlaces(query, lastPosition, app.settings.tmapApiKey);
      showResults(places);
      searchError = places.length ? '' : '검색 결과가 없습니다';
    } catch (err) {
      searchError = err instanceof Error ? err.message : String(err);
    }
    searchMessage.textContent = searchError;
  };

  app.onState((s: AppState) => {
    $('map-status').textContent = s.mapStatus;
    $('bg-report').textContent = s.backgroundReport;
    night.value = s.settings.nightMode;
    drowsy.checked = s.settings.drowsy.enabled;
    $('drowsy-status').textContent = s.drowsyStatus;
    $('home-name').textContent = s.settings.home?.name ?? '미등록';
    $('work-name').textContent = s.settings.work?.name ?? '미등록';
    $('trip-current').textContent = s.currentTrip ? `주행 중: ${tripText(s.currentTrip)}` : '';
    const list = $('trip-list');
    const sig = s.trips.map((t) => t.start).join(',');
    if (list.dataset.sig !== sig) {
      list.dataset.sig = sig;
      list.replaceChildren(
        ...s.trips.map((t) => {
          const li = document.createElement('li');
          li.textContent = `${tripDate(t)} · ${tripText(t)}`;
          return li;
        }),
      );
    }
    lastPosition = s.position ?? lastPosition;
    $('pill-glasses').classList.toggle('on', s.glasses);
    $('pill-gps').classList.toggle('on', s.gps);
    unit.value = s.settings.unit;
    tolerance.value = String(s.settings.overspeedTolerance);
    camera.checked = s.settings.cameraAlerts;
    demo.checked = s.settings.demo;
    if (document.activeElement !== tmapKey) tmapKey.value = s.settings.tmapApiKey;
    searchInput.disabled = s.settings.demo;
    $('nav-active').hidden = !s.destination;
    $('nav-dest').textContent = s.destination?.name ?? '';
    searchMessage.textContent = s.navMessage || searchError || (s.settings.demo ? '데모 주행 중에는 내장 경로로 안내합니다' : '');
  });
}

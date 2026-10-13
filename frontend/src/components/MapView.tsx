import { useEffect, useRef, useState } from 'react';
import { MapPin, RefreshCw, ExternalLink, Map } from 'lucide-react';
import type { Route, Trip } from '@stree/shared';
import { loadAmap } from '../lib/amap';

type Props = {
  trip: Trip;
  route: Route;
  dayIndex: number;
  selectedPoi: string | null;
  onSelect: (id: string) => void;
};
export default function MapView({ trip, route, dayIndex, selectedPoi, onSelect }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<Map<string, any>>(new globalThis.Map());
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const day = route.days[dayIndex];
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    const render = async () => {
      try {
        const AMap = await loadAmap(['AMap.Scale', 'AMap.ToolBar']);
        if (disposed || !element.current || !day) return;
        const map = new AMap.Map(element.current, {
          viewMode: '2D',
          zoom: 12,
          center: [trip.city.center.longitude, trip.city.center.latitude],
          mapStyle: 'amap://styles/whitesmoke',
        });
        mapRef.current = map;
        map.addControl(new AMap.Scale());
        map.addControl(new AMap.ToolBar({ position: 'RB' }));
        markersRef.current.clear();
        const overlays: any[] = [];
        day.segments.forEach((segment) => {
          const polyline = new AMap.Polyline({
            path: segment.polyline.map((p) => [p.longitude, p.latitude]),
            strokeColor: '#385b47',
            strokeWeight: 6,
            strokeOpacity: 0.85,
            showDir: true,
            lineJoin: 'round',
          });
          overlays.push(polyline);
        });
        day.stops.forEach((stop, index) => {
          const content = document.createElement('button');
          content.className = 'map-pin';
          content.textContent = String(index + 1);
          content.title = stop.poi.name;
          content.setAttribute('aria-label', stop.poi.name);
          const marker = new AMap.Marker({
            position: [stop.poi.location.longitude, stop.poi.location.latitude],
            content,
            offset: new AMap.Pixel(-17, -17),
          });
          marker.on('click', () => selectRef.current(stop.poiId));
          markersRef.current.set(stop.poiId, marker);
          overlays.push(marker);
        });
        if (day.hotel) {
          const marker = new AMap.Marker({
            position: [day.hotel.location.longitude, day.hotel.location.latitude],
            label: { content: '住宿', direction: 'top' },
          });
          overlays.push(marker);
        }
        map.add(overlays);
        if (overlays.length) map.setFitView(overlays, false, [60, 50, 60, 50]);
        setLoading(false);
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : '地图加载失败');
          setLoading(false);
        }
      }
    };
    void render();
    return () => {
      disposed = true;
      mapRef.current?.destroy();
      mapRef.current = null;
      markersRef.current.clear();
    };
  }, [trip.id, trip.updatedAt, route.id, dayIndex, attempt]);
  useEffect(() => {
    if (!selectedPoi) return;
    const marker = markersRef.current.get(selectedPoi);
    if (marker && mapRef.current) {
      mapRef.current.panTo(marker.getPosition());
    }
  }, [selectedPoi, loading]);
  if (!day) return null;
  const first = day.stops[0];
  const last = day.stops.at(-1);
  const mapLink =
    first && last
      ? `https://uri.amap.com/navigation?from=${first.poi.location.longitude},${first.poi.location.latitude},${encodeURIComponent(first.poi.name)}&to=${last.poi.location.longitude},${last.poi.location.latitude},${encodeURIComponent(last.poi.name)}&mode=${trip.request.transport === 'transit' ? 'bus' : trip.request.transport === 'walking' ? 'walk' : 'car'}&src=stree&callnative=0`
      : null;
  return (
    <section className="map-panel">
      <div className="map-topline">
        <span>
          <span className="live-dot" /> 实际交通路线
        </span>
        <span>DAY {String(day.day).padStart(2, '0')}</span>
      </div>
      <div
        className="map-canvas"
        ref={element}
        aria-label={`${trip.city.name}第${day.day}天路线地图`}
      />
      {loading && (
        <div className="map-overlay">
          <RefreshCw className="spin" size={22} />
          <p>正在展开城市地图</p>
        </div>
      )}
      {error && (
        <div className="map-overlay map-error">
          <Map size={30} />
          <strong>地图暂时未能加载</strong>
          <p>{error}</p>
          <button className="button button-small" onClick={() => setAttempt((a) => a + 1)}>
            重新加载
          </button>
        </div>
      )}
      <div className="map-bottomline">
        <span>
          <MapPin size={15} />
          {day.stops.length} 个停靠点 · {(day.distanceMeters / 1000).toFixed(1)} km · 交通约{' '}
          {day.transitMinutes} 分钟
        </span>
        {mapLink && (
          <a href={mapLink} target="_blank" rel="noreferrer">
            在高德打开 <ExternalLink size={14} />
          </a>
        )}
      </div>
    </section>
  );
}

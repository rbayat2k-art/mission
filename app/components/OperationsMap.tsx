"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap } from "leaflet";

export type MapCurrentLocation = {
  id: string; userId: string; fullName: string; latitude: number; longitude: number; accuracy: number; recordedAt: string;
  receivedAt?: string; isLive?: boolean; workSessionStatus?: string; source?: "gps" | "work_point";
};

export type MapDestination = {
  id: string; missionId: string; missionTitle: string; userId: string; fullName: string; destinationName: string;
  latitude: number; longitude: number; accuracy: number; recordedAt: string; dateKey: string; sequence: number;
};

export type MapTracePoint = {
  kind: "start" | "destination" | "end";
  title: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  recordedAt: string;
  source: "captured" | "nearest_gps";
};

export type MapRouteSegment = {
  id: string;
  userId: string;
  fullName: string;
  workSessionId: string;
  points: Array<{
    id: string;
    latitude: number;
    longitude: number;
    accuracy: number;
    speed: number | null;
    recordedAt: string;
  }>;
};

export type MapRouteStop = {
  id: string;
  userId: string;
  fullName: string;
  workSessionId: string;
  latitude: number;
  longitude: number;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  pointCount: number;
};

export type MapGpsGap = {
  id: string;
  userId: string;
  fullName: string;
  workSessionId: string;
  from: MapRouteSegment["points"][number];
  to: MapRouteSegment["points"][number];
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
};

function popupContent(title: string, rows: Array<[string, string]>) {
  const root = document.createElement("div");
  root.className = "operations-map-popup";
  const heading = document.createElement("strong");
  heading.textContent = title;
  root.appendChild(heading);
  for (const [label, value] of rows) {
    const row = document.createElement("span");
    const key = document.createElement("b");
    key.textContent = `${label}: `;
    row.append(key, document.createTextNode(value));
    root.appendChild(row);
  }
  return root;
}

function routeColor(userId: string) {
  const palette = ["#3867e8", "#1f9d78", "#8b5cf6", "#e38b2c", "#d64f6f", "#1689a7"];
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function locationPresentation(location: MapCurrentLocation) {
  const ageMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(location.recordedAt)) / 60_000));
  if (location.isLive) return { color: "#18a77d", fill: "#5ed7b2", className: "live", status: "زنده" };
  if (ageMinutes <= 30) return { color: "#d88919", fill: "#f4b84a", className: "recent", status: "آخرین موقعیت؛ تازه" };
  return { color: "#778397", fill: "#aab3c0", className: "stale", status: "آخرین موقعیت؛ زنده نیست" };
}

function relativeLocationTime(recordedAt: string) {
  const ageMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(recordedAt)) / 60_000));
  if (ageMinutes < 1) return "کمتر از یک دقیقه قبل";
  if (ageMinutes < 60) return `${ageMinutes.toLocaleString("fa-IR")} دقیقه قبل`;
  const hours = Math.floor(ageMinutes / 60);
  if (hours < 24) return `${hours.toLocaleString("fa-IR")} ساعت قبل`;
  return `${Math.floor(hours / 24).toLocaleString("fa-IR")} روز قبل`;
}

export default function OperationsMap({ currentLocations, destinations, routeSegments = [], routeStops = [], gpsGaps = [], tracePoints = [], large = false }: { currentLocations: MapCurrentLocation[]; destinations: MapDestination[]; routeSegments?: MapRouteSegment[]; routeStops?: MapRouteStop[]; gpsGaps?: MapGpsGap[]; tracePoints?: MapTracePoint[]; large?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const savedViewRef = useRef<{ latitude: number; longitude: number; zoom: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const renderMap = async () => {
      const L = await import("leaflet");
      if (cancelled || !containerRef.current) return;
      mapRef.current?.remove();
      containerRef.current.replaceChildren();
      const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true });
      mapRef.current = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);

      const bounds: [number, number][] = [];
      for (const location of currentLocations) {
        const point: [number, number] = [location.latitude, location.longitude];
        const presentation = locationPresentation(location);
        bounds.push(point);
        L.circle(point, { radius: Math.max(3, location.accuracy), color: presentation.color, weight: 1, fillColor: presentation.fill, fillOpacity: 0.12 }).addTo(map);
        L.circleMarker(point, { radius: 9, color: "#ffffff", weight: 3, fillColor: presentation.color, fillOpacity: 1, className: `operations-location-marker ${presentation.className}` })
          .bindPopup(popupContent(location.isLive ? "مکان فعلی" : location.source === "work_point" ? "آخرین نقطه کاری؛ GPS زنده نیست" : "آخرین موقعیت ثبت‌شده", [["کارمند", location.fullName], ["وضعیت", location.source === "work_point" ? "ثبت مأموریت؛ موقعیت زنده در دسترس نیست" : presentation.status], ["زمان", new Date(location.recordedAt).toLocaleString("fa-IR")], ["فاصله زمانی", relativeLocationTime(location.recordedAt)], ["دقت", `${Math.round(location.accuracy).toLocaleString("fa-IR")} متر`], ["مختصات", `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`]]))
          .addTo(map);
      }

      const routes = new Map<string, MapDestination[]>();
      for (const destination of destinations) {
        const point: [number, number] = [destination.latitude, destination.longitude];
        bounds.push(point);
        const color = routeColor(destination.userId);
        const marker = L.marker(point, {
          icon: L.divIcon({ className: "operations-pin-shell", html: `<span style="--pin-color:${color}"><b>${destination.sequence.toLocaleString("fa-IR")}</b></span>`, iconSize: [34, 42], iconAnchor: [17, 42], popupAnchor: [0, -38] }),
        });
        marker.bindPopup(popupContent(`مقصد شماره ${destination.sequence.toLocaleString("fa-IR")}`, [["کارمند", destination.fullName], ["مأموریت", destination.missionTitle], ["مقصد", destination.destinationName], ["زمان ثبت", new Date(destination.recordedAt).toLocaleString("fa-IR")]]));
        marker.addTo(map);
        const routeKey = `${destination.userId}:${destination.dateKey}`;
        routes.set(routeKey, [...(routes.get(routeKey) ?? []), destination]);
      }
      for (const route of routes.values()) {
        if (route.length < 2) continue;
        const ordered = [...route].sort((a, b) => a.sequence - b.sequence);
        L.polyline(ordered.map((item) => [item.latitude, item.longitude] as [number, number]), { color: routeColor(ordered[0].userId), weight: 3, opacity: 0.65, dashArray: "7 7" }).addTo(map);
      }

      for (const segment of routeSegments) {
        const linePoints = segment.points.map((point) => [point.latitude, point.longitude] as [number, number]);
        bounds.push(...linePoints);
        if (linePoints.length < 2) continue;
        const firstPoint = segment.points[0];
        const lastPoint = segment.points[segment.points.length - 1];
        L.polyline(linePoints, {
          color: routeColor(segment.userId), weight: 4, opacity: 0.82, lineCap: "round", lineJoin: "round",
        }).bindPopup(popupContent(`مسیر واقعی ${segment.fullName}`, [
          ["شروع این بخش", new Date(firstPoint.recordedAt).toLocaleString("fa-IR")],
          ["پایان این بخش", new Date(lastPoint.recordedAt).toLocaleString("fa-IR")],
          ["نقاط معتبر", segment.points.length.toLocaleString("fa-IR")],
        ])).addTo(map);
      }

      for (const stop of routeStops) {
        const point: [number, number] = [stop.latitude, stop.longitude];
        bounds.push(point);
        L.circleMarker(point, { radius: 8, color: "#ffffff", weight: 3, fillColor: "#e38b2c", fillOpacity: 0.95 })
          .bindPopup(popupContent(`توقف ${stop.fullName}`, [
            ["شروع توقف", new Date(stop.startedAt).toLocaleString("fa-IR")],
            ["پایان توقف", new Date(stop.endedAt).toLocaleString("fa-IR")],
            ["مدت", `${stop.durationMinutes.toLocaleString("fa-IR")} دقیقه`],
            ["نقاط معتبر", stop.pointCount.toLocaleString("fa-IR")],
          ])).addTo(map);
      }

      for (const gap of gpsGaps) {
        // Deliberately render only the two ends. A line across a GPS gap would
        // falsely imply that the employee travelled along that connection.
        const before: [number, number] = [gap.from.latitude, gap.from.longitude];
        const resumed: [number, number] = [gap.to.latitude, gap.to.longitude];
        bounds.push(before, resumed);
        L.circleMarker(before, { radius: 5, color: "#d65353", weight: 2, fillColor: "#ffffff", fillOpacity: 1 }).addTo(map);
        L.circleMarker(resumed, { radius: 7, color: "#ffffff", weight: 2, fillColor: "#d65353", fillOpacity: 1 })
          .bindPopup(popupContent(`وقفه GPS ${gap.fullName}`, [
            ["قطع از", new Date(gap.startedAt).toLocaleString("fa-IR")],
            ["دریافت مجدد", new Date(gap.endedAt).toLocaleString("fa-IR")],
            ["مدت وقفه", `${gap.durationMinutes.toLocaleString("fa-IR")} دقیقه`],
          ])).addTo(map);
      }

      for (const tracePoint of tracePoints) {
        const point: [number, number] = [tracePoint.latitude, tracePoint.longitude];
        bounds.push(point);
        const markerLabel = tracePoint.kind === "start" ? "شروع" : tracePoint.kind === "destination" ? "مقصد" : "پایان";
        L.circle(point, { radius:Math.max(3, tracePoint.accuracy), color:tracePoint.kind === "start" ? "#1f9d78" : tracePoint.kind === "destination" ? "#3867e8" : "#d65353", weight:1, fillOpacity:0.08 }).addTo(map);
        L.marker(point, {
          icon:L.divIcon({ className:`mission-trace-marker ${tracePoint.kind}`, html:`<span><b>${markerLabel}</b></span>`, iconSize:[48,48], iconAnchor:[24,42], popupAnchor:[0,-38] }),
        }).bindPopup(popupContent(tracePoint.title, [["زمان", new Date(tracePoint.recordedAt).toLocaleString("fa-IR")], ["دقت", `${Math.round(tracePoint.accuracy).toLocaleString("fa-IR")} متر`], ["منبع", tracePoint.source === "captured" ? "ثبت مستقیم دکمه" : "نزدیک‌ترین GPS موجود"]])).addTo(map);
      }
      if (tracePoints.length > 1) {
        L.polyline(tracePoints.map((point) => [point.latitude, point.longitude] as [number, number]), { color:"#243a64", weight:3, opacity:0.72, dashArray:"8 6" }).addTo(map);
      }

      if (savedViewRef.current) map.setView([savedViewRef.current.latitude, savedViewRef.current.longitude], savedViewRef.current.zoom);
      else if (bounds.length === 1) map.setView(bounds[0], 15);
      else if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds), { padding: [42, 42], maxZoom: 16 });
      else map.setView([35.6892, 51.389], 11);
      window.setTimeout(() => map.invalidateSize(), 0);
    };
    renderMap().catch(() => undefined);
    return () => {
      cancelled = true;
      if (mapRef.current) {
        const center = mapRef.current.getCenter();
        savedViewRef.current = { latitude: center.lat, longitude: center.lng, zoom: mapRef.current.getZoom() };
      }
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [currentLocations, destinations, routeSegments, routeStops, gpsGaps, tracePoints]);

  return <div className={`operations-map ${large ? "large" : ""}`}>
    <div ref={containerRef} className="operations-map-canvas" aria-label="نقشه موقعیت فعلی، مسیر واقعی حرکت و مقصدهای ثبت‌شده" />
    <div className="operations-map-legend">{tracePoints.length ? <><span><i className="trace-start" />شروع</span><span><i className="trace-destination" />مقصد</span><span><i className="trace-end" />پایان</span></> : <><span><i className="live" />زنده</span>{routeSegments.some(segment=>segment.points.length>1)&&<span><i className="route" />مسیر واقعی روز</span>}{routeStops.length>0&&<span><i className="route-stop" />توقف</span>}{gpsGaps.length>0&&<span><i className="route-gap" />وقفه GPS</span>}{currentLocations.some(location=>!location.isLive)&&<><span><i className="recent" />تا ۳۰ دقیقه</span><span><i className="stale" />قدیمی</span></>}<span><i className="pin" />مقصدهای شماره‌دار</span></>}</div>
  </div>;
}

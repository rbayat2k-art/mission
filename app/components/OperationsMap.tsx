"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap } from "leaflet";

export type MapCurrentLocation = {
  id: string; userId: string; fullName: string; latitude: number; longitude: number; accuracy: number; recordedAt: string;
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

export default function OperationsMap({ currentLocations, destinations, tracePoints = [], large = false }: { currentLocations: MapCurrentLocation[]; destinations: MapDestination[]; tracePoints?: MapTracePoint[]; large?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);

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
        bounds.push(point);
        L.circle(point, { radius: Math.max(3, location.accuracy), color: "#1f9d78", weight: 1, fillColor: "#5ed7b2", fillOpacity: 0.12 }).addTo(map);
        L.circleMarker(point, { radius: 9, color: "#ffffff", weight: 3, fillColor: "#18a77d", fillOpacity: 1, className: "operations-live-marker" })
          .bindPopup(popupContent("مکان فعلی", [["کارمند", location.fullName], ["زمان", new Date(location.recordedAt).toLocaleString("fa-IR")], ["دقت", `${Math.round(location.accuracy).toLocaleString("fa-IR")} متر`]]))
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

      if (bounds.length === 1) map.setView(bounds[0], 15);
      else if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds), { padding: [42, 42], maxZoom: 16 });
      else map.setView([35.6892, 51.389], 11);
      window.setTimeout(() => map.invalidateSize(), 0);
    };
    renderMap().catch(() => undefined);
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [currentLocations, destinations, tracePoints]);

  return <div className={`operations-map ${large ? "large" : ""}`}>
    <div ref={containerRef} className="operations-map-canvas" aria-label="نقشه موقعیت فعلی و مقصدهای ثبت‌شده" />
    <div className="operations-map-legend">{tracePoints.length ? <><span><i className="trace-start" />شروع</span><span><i className="trace-destination" />مقصد</span><span><i className="trace-end" />پایان</span></> : <><span><i className="live" />مکان فعلی</span><span><i className="pin" />مقصدهای شماره‌دار</span></>}</div>
  </div>;
}

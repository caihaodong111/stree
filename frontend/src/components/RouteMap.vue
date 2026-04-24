<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { planStopsRoute } from "../api/client";
import AppIcon from "./AppIcon.vue";
import { loadAmap } from "../lib/amap";
import { planStopsRouteWithAmap } from "../lib/amapRoutePlanner";
import type { LocationPoint, MapRouteResponse } from "../types";

const props = defineProps<{
  origin: LocationPoint;
  stops: LocationPoint[];
  mode: "walking" | "driving" | "transfer";
}>();

const mapElement = ref<HTMLElement | null>(null);
const loading = ref(true);
const error = ref("");
const routeResult = ref<MapRouteResponse | null>(null);
const hasKey = computed(() => Boolean(import.meta.env.VITE_AMAP_KEY));
const hasStops = computed(() => props.stops.length > 0);
const modeLabel = computed(() => {
  const effectiveMode = routeResult.value?.mode ?? props.mode;
  const requestedMode = routeResult.value?.requested_mode ?? props.mode;

  if (requestedMode === "walking" && effectiveMode === "driving") {
    return "步行已自动切换驾车";
  }
  if (requestedMode === "walking" && routeResult.value?.segments.some((segment) => segment.mode === "driving")) {
    return "步行优先，超远段已驾车";
  }
  if (effectiveMode === "walking") {
    return "步行模式";
  }
  if (effectiveMode === "driving") {
    return "驾车模式";
  }
  return "公交模式";
});

let mapInstance: any = null;
let renderVersion = 0;
let markers: any[] = [];
let routePolylines: any[] = [];
let routeServices: any[] = [];

type Coordinate = [number, number];

function createOriginMarker(AMap: any, position: Coordinate) {
  return new AMap.Marker({
    position,
    content: `<div class="map-origin-marker" aria-label="当前位置"></div>`,
    offset: new AMap.Pixel(-11, -11)
  });
}

function createStopMarker(AMap: any, name: string, position: Coordinate, index: number) {
  return new AMap.Marker({
    position,
    title: name,
    label: {
      content: `<div class="map-label">第 ${index} 站 · ${name}</div>`,
      direction: "top"
    }
  });
}

function clearOverlays() {
  routeServices.forEach((service) => {
    if (typeof service?.clear === "function") {
      service.clear();
    }
  });
  routeServices = [];

  if (mapInstance && markers.length) {
    mapInstance.remove(markers);
  }
  markers = [];

  if (mapInstance && routePolylines.length) {
    mapInstance.remove(routePolylines);
  }
  routePolylines = [];
}

function destroyMap() {
  clearOverlays();
  if (mapInstance) {
    mapInstance.destroy();
    mapInstance = null;
  }
}

function formatDistance(distanceMeters: number | null) {
  if (distanceMeters == null) {
    return "距离待定";
  }
  if (distanceMeters >= 1000) {
    return `${(distanceMeters / 1000).toFixed(1)} km`;
  }
  return `${distanceMeters} m`;
}

function formatPrice(price: number | null) {
  if (price == null) {
    return "费用待定";
  }
  if (price === 0) {
    return "0 元";
  }
  return `${price.toFixed(0)} 元`;
}

function polylineColor(mode: "walking" | "driving" | "transfer") {
  if (mode === "walking") {
    return "#165a4c";
  }
  if (mode === "driving") {
    return "#be6a2f";
  }
  return "#2d61ba";
}

async function renderMap() {
  const currentVersion = ++renderVersion;
  loading.value = true;
  error.value = "";
  const payload = {
    mode: props.mode,
    origin_name: props.origin.name,
    origin_longitude: props.origin.longitude,
    origin_latitude: props.origin.latitude,
    stops: props.stops.map((stop) => ({
      name: stop.name,
      longitude: stop.longitude,
      latitude: stop.latitude
    }))
  };

  if (!hasStops.value) {
    routeResult.value = null;
    destroyMap();
    loading.value = false;
    error.value = "";
    return;
  }

  try {
    if (mapElement.value && hasKey.value) {
      const AMap = await loadAmap([
        "AMap.Scale",
        "AMap.ToolBar",
        "AMap.Walking",
        "AMap.Driving",
        "AMap.Transfer"
      ]);

      if (currentVersion !== renderVersion) {
        return;
      }

      destroyMap();

      mapInstance = new AMap.Map(mapElement.value, {
        viewMode: "2D",
        zoom: 12,
        center: [props.origin.longitude, props.origin.latitude],
        mapStyle: "amap://styles/whitesmoke"
      });

      mapInstance.addControl(new AMap.Scale());
      mapInstance.addControl(new AMap.ToolBar({ position: "RB" }));

      markers = [createOriginMarker(AMap, [props.origin.longitude, props.origin.latitude])];

      props.stops.forEach((stop, index) => {
        markers.push(
          createStopMarker(
            AMap,
            stop.name,
            [stop.longitude, stop.latitude],
            index + 1
          )
        );
      });

      mapInstance.add(markers);

      try {
        const planned = await planStopsRouteWithAmap({
          AMap,
          map: mapInstance,
          origin: props.origin,
          stops: props.stops,
          mode: props.mode
        });

        if (currentVersion !== renderVersion) {
          return;
        }

        routeServices = planned.services;
        routeResult.value = planned.response;
        mapInstance.setFitView(undefined, false, [60, 60, 60, 60]);
        return;
      } catch (plannerError) {
        routeServices.forEach((service) => {
          if (typeof service?.clear === "function") {
            service.clear();
          }
        });
        routeServices = [];
        routeResult.value = await planStopsRoute(payload);

        routePolylines = (routeResult.value?.segments ?? [])
          .filter((segment) => segment.polyline.length > 1)
          .map((segment) => {
            return new AMap.Polyline({
              path: segment.polyline.map((point) => [point.longitude, point.latitude]),
              strokeColor: polylineColor(segment.mode),
              strokeWeight: 6,
              strokeOpacity: 0.92,
              showDir: true,
              lineJoin: "round",
              lineCap: "round",
              isOutline: true,
              outlineColor: "rgba(255,255,255,0.86)",
              borderWeight: 2
            });
          });

        if (routePolylines.length) {
          mapInstance.add(routePolylines);
          mapInstance.setFitView([...markers, ...routePolylines], false, [60, 60, 60, 60]);
        } else {
          mapInstance.setFitView(markers, false, [80, 80, 80, 80]);
        }

        return;
      }
    }

    routeResult.value = await planStopsRoute(payload);
  } catch (err) {
    routeResult.value = null;
    destroyMap();
    error.value = err instanceof Error ? err.message : "地图渲染失败。";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  renderMap();
});

watch(
  () => [
    props.origin.name,
    props.origin.latitude,
    props.origin.longitude,
    props.stops.map((stop) => `${stop.name}-${stop.latitude}-${stop.longitude}`).join("|"),
    props.mode
  ],
  () => {
    renderMap();
  }
);

onBeforeUnmount(() => {
  destroyMap();
});
</script>

<template>
  <section class="route-map-block">
    <div class="route-map-stage">
      <div ref="mapElement" :class="['route-map', { 'route-map-hidden': !hasStops || !hasKey }]"></div>

      <div v-if="!hasStops" class="route-map-overlay">
        <div class="map-empty-state">
          <div class="map-empty-illustration">
            <span class="map-empty-orbit orbit-a"></span>
            <span class="map-empty-orbit orbit-b"></span>
            <span class="map-empty-core"><AppIcon name="map" /></span>
            <span class="map-empty-pin pin-a"><AppIcon name="pin" /></span>
            <span class="map-empty-pin pin-b"><AppIcon name="waypoint" /></span>
          </div>
          <div class="map-empty-copy">
            <strong>地图框架已就位</strong>
            <p>当你生成路线后，这里会把起点、必去点和顺路补点放到同一张辅助地图里。</p>
          </div>
        </div>
      </div>
      <div v-else-if="loading" class="route-map-overlay">
        <div class="map-state-card">
          <span class="map-state-icon"><AppIcon name="route" /></span>
          <strong>正在绘制路线</strong>
          <p>系统正在把推荐点位转换成真实路径和地图辅助视图。</p>
        </div>
      </div>
      <div v-else-if="!hasKey" class="route-map-overlay">
        <div class="map-state-card">
          <span class="map-state-icon"><AppIcon name="map" /></span>
          <strong>地图服务未启用</strong>
          <p>当前环境没有配置地图展示 Key，但下方的分段路径和文字说明仍然可用。</p>
        </div>
      </div>
      <div v-else-if="error" class="route-map-overlay route-map-error">
        <div class="map-state-card">
          <span class="map-state-icon"><AppIcon name="spark" /></span>
          <strong>地图渲染暂时失败</strong>
          <p>{{ error }}。如果后端已返回路线分段，下方仍会显示文字路径说明。</p>
        </div>
      </div>
    </div>

    <div v-if="routeResult" class="map-route-details">
      <div class="map-route-summary">
        <div class="map-route-summary-copy">
          <span class="section-kicker">路径分析</span>
          <strong>{{ routeResult.summary }}</strong>
        </div>
        <span class="route-style-pill route-style-muted">{{ modeLabel }}</span>
      </div>

      <div class="map-route-stat-row">
        <span class="stop-chip">
          总耗时 {{ routeResult.total_duration_minutes != null ? `${routeResult.total_duration_minutes} 分钟` : "待定" }}
        </span>
        <span class="stop-chip">总距离 {{ formatDistance(routeResult.total_distance_meters) }}</span>
        <span class="stop-chip">总费用 {{ formatPrice(routeResult.total_price) }}</span>
      </div>

      <div class="map-leg-grid">
        <article
          v-for="(segment, index) in routeResult.segments"
          :key="`${segment.from_name}-${segment.to_name}-${index}`"
          class="map-leg-card"
        >
          <div class="map-leg-head">
            <strong>第 {{ index + 1 }} 段</strong>
            <span>{{ segment.from_name }} → {{ segment.to_name }}</span>
          </div>
          <p>{{ segment.summary }}</p>
          <div class="map-leg-metrics">
            <small>耗时 {{ segment.duration_minutes != null ? `${segment.duration_minutes} 分钟` : "待定" }}</small>
            <small>距离 {{ formatDistance(segment.distance_meters) }}</small>
            <small>费用 {{ formatPrice(segment.price) }}</small>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

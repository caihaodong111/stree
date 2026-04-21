<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { planStopsRoute } from "../api/client";
import AppIcon from "./AppIcon.vue";
import { loadAmap } from "../lib/amap";
import type { LocationPoint } from "../types";

const props = defineProps<{
  origin: LocationPoint;
  stops: LocationPoint[];
  mode: "walking" | "driving" | "transfer";
}>();

const mapElement = ref<HTMLElement | null>(null);
const loading = ref(true);
const error = ref("");
const hasKey = computed(() => Boolean(import.meta.env.VITE_AMAP_KEY));
const hasStops = computed(() => props.stops.length > 0);

let mapInstance: any = null;
let renderVersion = 0;
let markers: any[] = [];
let routePolylines: any[] = [];

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

async function renderMap() {
  const currentVersion = ++renderVersion;
  loading.value = true;
  error.value = "";

  if (!mapElement.value) {
    return;
  }

  if (!hasStops.value) {
    destroyMap();
    loading.value = false;
    error.value = "";
    return;
  }

  if (!hasKey.value) {
    destroyMap();
    loading.value = false;
    error.value = "";
    return;
  }

  try {
    const AMap = await loadAmap(["AMap.Scale", "AMap.ToolBar"]);

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

    if (!props.stops.length) {
      mapInstance.setFitView(markers, false, [80, 80, 80, 80]);
      return;
    }

    const routeResult = await planStopsRoute({
      mode: props.mode,
      origin_name: props.origin.name,
      origin_longitude: props.origin.longitude,
      origin_latitude: props.origin.latitude,
      stops: props.stops.map((stop) => ({
        name: stop.name,
        longitude: stop.longitude,
        latitude: stop.latitude
      }))
    });

    if (currentVersion !== renderVersion) {
      return;
    }

    routePolylines = routeResult.segments
      .filter((segment) => segment.polyline.length > 1)
      .map((segment) => {
        return new AMap.Polyline({
          path: segment.polyline.map((point) => [point.longitude, point.latitude]),
          strokeColor:
            props.mode === "walking"
              ? "#165a4c"
              : props.mode === "driving"
                ? "#be6a2f"
                : "#2d61ba",
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
  } catch (err) {
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
        <p>系统正在把推荐点位转换成地图辅助视图。</p>
      </div>
    </div>
    <div v-else-if="!hasKey" class="route-map-overlay">
      <div class="map-state-card">
        <span class="map-state-icon"><AppIcon name="map" /></span>
        <strong>地图服务未启用</strong>
        <p>当前环境没有配置地图展示 Key，但上方路线推荐和下方时段建议仍然可用。</p>
      </div>
    </div>
    <div v-else-if="error" class="route-map-overlay route-map-error">
      <div class="map-state-card">
        <span class="map-state-icon"><AppIcon name="spark" /></span>
        <strong>地图渲染暂时失败</strong>
        <p>{{ error }} 不影响当前行程建议。</p>
      </div>
    </div>
  </section>
</template>

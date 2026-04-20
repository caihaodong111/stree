<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { getRecommendations } from "./api/client";
import PreferenceForm from "./components/PreferenceForm.vue";
import RouteMap from "./components/RouteMap.vue";
import { geocodePlace } from "./lib/amap";
import type { LocationPoint, NavigationFormData, RecommendationRequest, RouteOption } from "./types";

const loading = ref(false);
const error = ref("");
const routeMode = ref<"walking" | "driving" | "transfer">("walking");
const origin = ref<LocationPoint>({
  name: "天安门东",
  latitude: 39.9087,
  longitude: 116.3975
});
const destination = ref<LocationPoint | null>(null);
const recommendedRoute = ref<RouteOption | null>(null);

const routeStops = computed<LocationPoint[]>(() => {
  const scenicStops =
    recommendedRoute.value?.pois.map((poi) => ({
      name: poi.name,
      latitude: poi.latitude,
      longitude: poi.longitude
    })) ?? [];

  return destination.value ? [...scenicStops, destination.value] : scenicStops;
});

const stopNames = computed(() => routeStops.value.map((stop) => stop.name));

const destinationDistrictMap: Record<string, string> = {
  故宫: "东城区",
  天坛: "东城区",
  雍和宫: "东城区",
  国博: "东城区",
  国家博物馆: "东城区",
  什刹海: "西城区",
  景山: "西城区",
  三里屯: "朝阳区",
  国贸: "朝阳区",
  798: "朝阳区",
  奥森: "朝阳区",
  奥林匹克森林公园: "朝阳区",
  颐和园: "海淀区",
  圆明园: "海淀区"
};

async function locateOrigin() {
  error.value = "";

  if (!navigator.geolocation) {
    error.value = "当前浏览器不支持定位。";
    return;
  }

  loading.value = true;

  navigator.geolocation.getCurrentPosition(
    (position) => {
      origin.value = {
        name: "我的位置",
        latitude: Number(position.coords.latitude.toFixed(6)),
        longitude: Number(position.coords.longitude.toFixed(6))
      };
      loading.value = false;
    },
    () => {
      error.value = "定位失败，请检查浏览器定位权限。";
      loading.value = false;
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000
    }
  );
}

function buildRecommendationPayload(payload: NavigationFormData, originPoint: LocationPoint): RecommendationRequest {
  const matchedDistricts = Object.entries(destinationDistrictMap)
    .filter(([keyword]) => payload.destination_query.includes(keyword))
    .map(([, district]) => district);

  return {
    origin_name: originPoint.name,
    origin_latitude: originPoint.latitude,
    origin_longitude: originPoint.longitude,
    budget: payload.budget,
    available_hours: payload.available_hours,
    travel_days: 1,
    preference_mode: payload.preference_mode,
    preferences: payload.preferences,
    preferred_districts: Array.from(new Set(matchedDistricts)),
    categories: [],
    special_interests: payload.destination_query ? [payload.destination_query] : [],
    max_poi_count: payload.max_poi_count,
    max_transit_minutes_per_leg: 60
  };
}

function pickRoute(preferenceMode: NavigationFormData["preference_mode"], routes: RouteOption[]): RouteOption | null {
  if (!routes.length) {
    return null;
  }

  return routes.find((route) => route.strategy === preferenceMode) ?? routes[0];
}

async function handleSubmit(payload: NavigationFormData) {
  loading.value = true;
  error.value = "";

  try {
    const nextOrigin =
      !payload.origin_query ||
      payload.origin_query === "我的位置" ||
      payload.origin_query === origin.value.name
        ? origin.value
        : await geocodePlace(payload.origin_query);

    const nextDestination = await geocodePlace(payload.destination_query);

    origin.value = nextOrigin;
    destination.value = nextDestination;

    const recommendationPayload = buildRecommendationPayload(payload, nextOrigin);
    const recommendation = await getRecommendations(recommendationPayload);
    recommendedRoute.value = pickRoute(payload.preference_mode, recommendation.route_options);
  } catch (err) {
    recommendedRoute.value = null;
    error.value = err instanceof Error ? err.message : "生成路线失败";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  locateOrigin();
});
</script>

<template>
  <main class="page-shell">
    <PreferenceForm :loading="loading" :initial-origin="origin" @submit="handleSubmit" @locate-origin="locateOrigin" />

    <div v-if="error" class="status-bar status-error">
      {{ error }}
    </div>
    <div v-else-if="loading" class="status-bar">
      正在解析地点并生成路线...
    </div>

    <section class="map-panel panel">
      <div v-if="destination" class="map-header">
        <div class="route-meta">
          <strong>{{ origin.name }}</strong>
          <span>→</span>
          <strong>{{ destination.name }}</strong>
          <span v-if="recommendedRoute">含 {{ recommendedRoute.pois.length }} 个推荐途经点</span>
        </div>

        <div v-if="recommendedRoute" class="stop-chip-row">
          <span v-for="name in stopNames" :key="name" class="stop-chip">{{ name }}</span>
        </div>
      </div>

      <RouteMap :origin="origin" :stops="routeStops" :mode="routeMode" />
    </section>

    <section v-if="destination" class="transport-switcher">
      <button
        type="button"
        :class="['transport-button', { active: routeMode === 'walking' }]"
        @click="routeMode = 'walking'"
      >
        步行
      </button>
      <button
        type="button"
        :class="['transport-button', { active: routeMode === 'driving' }]"
        @click="routeMode = 'driving'"
      >
        驾车
      </button>
      <button
        type="button"
        :class="['transport-button', { active: routeMode === 'transfer' }]"
        @click="routeMode = 'transfer'"
      >
        公交
      </button>
    </section>
  </main>
</template>

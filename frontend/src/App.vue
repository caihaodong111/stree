<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { getRecommendations } from "./api/client";
import PreferenceForm from "./components/PreferenceForm.vue";
import RouteCard from "./components/RouteCard.vue";
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
const destinationAnchor = ref("");
const destinationPoint = ref<LocationPoint | null>(null);
const planningRequest = ref<NavigationFormData | null>(null);
const routeOptions = ref<RouteOption[]>([]);
const recommendedRoute = ref<RouteOption | null>(null);

const routeStops = computed<LocationPoint[]>(() => {
  return (
    recommendedRoute.value?.pois.map((poi) => ({
      name: poi.name,
      latitude: poi.latitude,
      longitude: poi.longitude
    })) ?? []
  );
});

const stopNames = computed(() => routeStops.value.map((stop) => stop.name));

const planningRouteStyle = computed(() => {
  const availableHours = planningRequest.value?.available_hours ?? 0;
  if (!availableHours) {
    return "待生成";
  }
  if (availableHours <= 5) {
    return "轻松半日线";
  }
  if (availableHours >= 11) {
    return "周末两日线";
  }
  return "一日暴走线";
});

const planningFacts = computed(() => {
  const request = planningRequest.value;
  if (!request) {
    return [];
  }

  return [
    `${request.available_hours} 小时可玩`,
    `预算 ${request.budget} 元`,
    `${request.max_poi_count} 个推荐点位`
  ];
});

const planningSummary = computed(() => {
  if (!destinationAnchor.value || !planningRequest.value) {
    return "输入一个核心景点或片区，系统会返回候选游玩线和建议停留时段。";
  }

  return `正在围绕 ${destinationAnchor.value} 生成 ${planningRouteStyle.value}，优先返回候选游玩线、途经点和建议停留时段。`;
});

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

function buildRecommendationPayload(
  payload: NavigationFormData,
  originPoint: LocationPoint,
  destinationName: string,
  anchorPoint: LocationPoint | null
): RecommendationRequest {
  const matchedDistricts = Object.entries(destinationDistrictMap)
    .filter(([keyword]) => payload.destination_query.includes(keyword))
    .map(([, district]) => district);
  const inferredTravelDays = payload.available_hours >= 11 ? 2 : 1;

  return {
    origin_name: originPoint.name,
    origin_latitude: originPoint.latitude,
    origin_longitude: originPoint.longitude,
    destination_name: destinationName || null,
    destination_latitude: anchorPoint?.latitude ?? null,
    destination_longitude: anchorPoint?.longitude ?? null,
    budget: payload.budget,
    available_hours: payload.available_hours,
    travel_days: inferredTravelDays,
    preference_mode: payload.preference_mode,
    preferences: payload.preferences,
    preferred_districts: Array.from(new Set(matchedDistricts)),
    categories: [],
    special_interests: [],
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

function selectRoute(route: RouteOption) {
  recommendedRoute.value = route;
}

async function resolveOriginPoint(originQuery: string): Promise<LocationPoint> {
  const query = originQuery.trim();
  if (!query || query === "我的位置" || query === origin.value.name) {
    return origin.value;
  }

  try {
    return await geocodePlace(query);
  } catch {
    return {
      ...origin.value,
      name: query
    };
  }
}

async function resolveDestinationPoint(destinationQuery: string): Promise<LocationPoint | null> {
  try {
    return await geocodePlace(destinationQuery);
  } catch {
    return null;
  }
}

async function handleSubmit(payload: NavigationFormData) {
  const nextDestinationQuery = payload.destination_query.trim();
  if (!nextDestinationQuery) {
    error.value = "请先输入核心景点或想去哪一带。";
    destinationAnchor.value = "";
    destinationPoint.value = null;
    routeOptions.value = [];
    recommendedRoute.value = null;
    return;
  }

  loading.value = true;
  error.value = "";
  planningRequest.value = payload;
  destinationAnchor.value = nextDestinationQuery;
  destinationPoint.value = null;
  routeOptions.value = [];
  recommendedRoute.value = null;

  try {
    const [nextOrigin, nextDestinationPoint] = await Promise.all([
      resolveOriginPoint(payload.origin_query),
      resolveDestinationPoint(nextDestinationQuery)
    ]);

    origin.value = nextOrigin;
    destinationPoint.value = nextDestinationPoint;

    const recommendationPayload = buildRecommendationPayload(
      payload,
      nextOrigin,
      nextDestinationQuery,
      nextDestinationPoint
    );
    const recommendation = await getRecommendations(recommendationPayload);
    routeOptions.value = recommendation.route_options;
    recommendedRoute.value = pickRoute(payload.preference_mode, recommendation.route_options);
    if (!recommendedRoute.value) {
      error.value = `围绕 ${nextDestinationQuery} 暂未生成可用游玩线。`;
    }
  } catch (err) {
    routeOptions.value = [];
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

    <section v-if="destinationAnchor" class="panel overview-panel">
      <div class="overview-header">
        <div class="route-meta">
          <strong>{{ origin.name }}</strong>
          <span>出发地</span>
          <span>围绕 {{ destinationAnchor }} 推荐游玩线</span>
          <span v-if="recommendedRoute">
            {{ recommendedRoute.route_style }} · 含 {{ recommendedRoute.pois.length }} 个推荐途经点
          </span>
        </div>

        <span :class="['route-style-pill', { 'route-style-muted': !recommendedRoute }]">
          {{ recommendedRoute?.route_style ?? planningRouteStyle }}
        </span>
      </div>

      <div v-if="planningFacts.length" class="stop-chip-row">
        <span v-for="fact in planningFacts" :key="fact" class="stop-chip">{{ fact }}</span>
      </div>

      <p class="overview-copy">
        {{ recommendedRoute?.highlight_reason ?? planningSummary }}
      </p>

      <div v-if="recommendedRoute" class="stop-chip-row">
        <span v-for="name in stopNames" :key="name" class="stop-chip">{{ name }}</span>
      </div>

      <div v-if="routeOptions.length" class="route-card-row">
        <RouteCard
          v-for="route in routeOptions"
          :key="route.strategy"
          :route="route"
          :selected="recommendedRoute?.strategy === route.strategy"
          @select="selectRoute(route)"
        />
      </div>
    </section>

    <section v-if="recommendedRoute" class="panel itinerary-panel">
      <div class="itinerary-header">
        <div>
          <strong>{{ recommendedRoute.title }}</strong>
          <p>{{ recommendedRoute.highlight_reason }}</p>
        </div>
        <span class="route-style-pill">{{ recommendedRoute.route_style }}</span>
      </div>

      <div class="itinerary-grid">
        <article v-for="item in recommendedRoute.itinerary" :key="`${item.day_index}-${item.poi_name}-${item.start_time}`" class="itinerary-item">
          <span class="itinerary-day">Day {{ item.day_index }}</span>
          <strong>{{ item.start_time }} - {{ item.end_time }}</strong>
          <span>{{ item.poi_name }}</span>
          <small>停留 {{ item.stay_hours }} 小时 · 接驳 {{ item.transit_minutes_from_previous }} 分钟</small>
        </article>
      </div>
    </section>

    <section v-else class="panel itinerary-panel placeholder-panel">
      <div class="placeholder-copy">
        <strong>
          {{ destinationAnchor ? `正在围绕 ${destinationAnchor} 生成游玩线` : "输入一个核心景点或片区开始推荐" }}
        </strong>
        <p>
          {{
            destinationAnchor
              ? planningSummary
              : "例如 故宫、国贸、什刹海、颐和园。系统返回的是候选游玩线、途经点和建议停留时段，不是点对点导航。"
          }}
        </p>
      </div>
    </section>

    <section class="map-panel panel">
      <div class="map-panel-header">
        <div class="map-panel-copy">
          <strong>地图辅助视图</strong>
          <span>只用于查看候选游玩线的空间分布，不决定推荐结果</span>
        </div>
      </div>

      <RouteMap :origin="origin" :stops="routeStops" :mode="routeMode" />
    </section>

    <section v-if="recommendedRoute" class="transport-panel panel">
      <div class="transport-panel-header">
        <strong>地图查看方式</strong>
        <span>仅影响路线展示，不改变推荐线路内容</span>
      </div>

      <div class="transport-switcher">
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
      </div>
    </section>
  </main>
</template>

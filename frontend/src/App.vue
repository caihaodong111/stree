<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { getRecommendations } from "./api/client";
import AppIcon from "./components/AppIcon.vue";
import PreferenceForm from "./components/PreferenceForm.vue";
import RouteCard from "./components/RouteCard.vue";
import RouteMap from "./components/RouteMap.vue";
import { geocodePlace } from "./lib/amap";
import type { LocationPoint, NavigationFormData, RecommendationRequest, RouteOption } from "./types";

const DEFAULT_BUDGET = 600;
const DEFAULT_AVAILABLE_HOURS = 8;

const loading = ref(false);
const locatingOrigin = ref(false);
const error = ref("");
const routeMode = ref<"walking" | "driving" | "transfer">("walking");
const origin = ref<LocationPoint>({
  name: "天安门东",
  latitude: 39.9087,
  longitude: 116.3975
});
const destinationAnchor = ref("");
const preferredDistrict = ref("");
const planningRequest = ref<NavigationFormData | null>(null);
const routeOptions = ref<RouteOption[]>([]);
const recommendedRoute = ref<RouteOption | null>(null);
const appliedDefaults = ref<string[]>([]);
const matchedMustVisitNames = ref<string[]>([]);
const missingMustVisitNames = ref<string[]>([]);

const routeStops = computed<LocationPoint[]>(() => {
  return (
    recommendedRoute.value?.pois.map((poi) => ({
      name: poi.name,
      latitude: poi.latitude,
      longitude: poi.longitude
    })) ?? []
  );
});

const stopHighlights = computed(() => recommendedRoute.value?.stop_highlights ?? []);
const stopNames = computed(() => routeStops.value.map((stop) => stop.name));
const requestedMustVisits = computed(() => planningRequest.value?.must_visit_names ?? []);
const effectiveBudget = computed(() => planningRequest.value?.budget ?? DEFAULT_BUDGET);
const effectiveAvailableHours = computed(() => planningRequest.value?.available_hours ?? DEFAULT_AVAILABLE_HOURS);
const planningModeLabel = computed(() => {
  const hasDestination = Boolean(destinationAnchor.value);
  const hasDistrict = Boolean(preferredDistrict.value);
  const mustVisitCount = requestedMustVisits.value.length;
  const request = planningRequest.value;

  if (mustVisitCount >= 2 && (hasDestination || hasDistrict)) {
    return "必去点串联 + 定向补点";
  }
  if (mustVisitCount >= 2) {
    return "多必去点串联";
  }
  if (mustVisitCount === 1 && (hasDestination || hasDistrict)) {
    return "单必去点 + 定向补点";
  }
  if (mustVisitCount === 1) {
    return "单必去点规划";
  }
  if (hasDestination && hasDistrict) {
    return "目的地 + 片区规划";
  }
  if (hasDestination) {
    return "目的地锚点规划";
  }
  if (hasDistrict) {
    return "片区偏好规划";
  }
  if (request?.budget != null && request.available_hours == null) {
    return "预算导向自动规划";
  }
  if (request?.available_hours != null && request.budget == null) {
    return "时长导向自动规划";
  }
  if (request?.budget != null && request.available_hours != null) {
    return "条件组合规划";
  }
  return "自由探索规划";
});
const routeStats = computed(() => {
  if (!recommendedRoute.value) {
    return [];
  }

  const dayCount = new Set(recommendedRoute.value.itinerary.map((item) => item.day_index)).size || 1;

  return [
    {
      icon: "wallet" as const,
      label: "预计预算",
      value: `${recommendedRoute.value.total_budget} 元`,
      hint: "含门票、餐饮与交通估算"
    },
    {
      icon: "clock" as const,
      label: "总时长",
      value: `${recommendedRoute.value.total_duration_hours} 小时`,
      hint: `${dayCount} 天内可完成`
    },
    {
      icon: "route" as const,
      label: "空间跨度",
      value: `${recommendedRoute.value.total_travel_km} km`,
      hint: "适合先看地图再决定节奏"
    },
    {
      icon: "waypoint" as const,
      label: "推荐站点",
      value: `${recommendedRoute.value.pois.length} 个`,
      hint: stopNames.value.join(" · ") || "已自动补足顺路点"
    }
  ];
});
const heroTitle = computed(() => {
  const mustVisits = requestedMustVisits.value;
  if (mustVisits.length >= 2) {
    return `把 ${mustVisits.slice(0, 2).join(" 和 ")} 串进一条顺手的路线`;
  }
  if (mustVisits.length === 1 && destinationAnchor.value && preferredDistrict.value) {
    return `先保证 ${mustVisits[0]}，再围绕 ${destinationAnchor.value} 补 ${preferredDistrict.value} 内的顺路景点`;
  }
  if (mustVisits.length === 1 && destinationAnchor.value) {
    return `先保证 ${mustVisits[0]}，再围绕 ${destinationAnchor.value} 补顺路景点`;
  }
  if (mustVisits.length === 1 && preferredDistrict.value) {
    return `先保证 ${mustVisits[0]}，再优先补 ${preferredDistrict.value} 内的顺路景点`;
  }
  if (mustVisits.length === 1) {
    return `先保证 ${mustVisits[0]}，再自动补顺路景点`;
  }
  if (destinationAnchor.value && preferredDistrict.value) {
    return `围绕 ${destinationAnchor.value}，优先落在 ${preferredDistrict.value} 的范围里排线`;
  }
  if (destinationAnchor.value) {
    return `围绕 ${destinationAnchor.value} 生成更顺手的游玩线`;
  }
  if (preferredDistrict.value) {
    return `优先在 ${preferredDistrict.value} 内生成更顺手的游玩线`;
  }
  if (planningRequest.value?.budget != null && planningRequest.value.available_hours == null) {
    return "按你的预算去筛当前最合适的路线";
  }
  if (planningRequest.value?.available_hours != null && planningRequest.value.budget == null) {
    return "按你的可玩时长压缩最顺手的路线";
  }
  return "给几个条件，系统把路线先排顺";
});
const heroDescription = computed(() => {
  if (requestedMustVisits.value.length) {
    if (destinationAnchor.value && preferredDistrict.value) {
      return "先锁定必去点，再结合具体目的地和偏好片区补点。";
    }
    if (destinationAnchor.value) {
      return "先锁定必去点，再围绕具体目的地补顺路景点。";
    }
    if (preferredDistrict.value) {
      return "先锁定必去点，再优先在偏好片区里补点。";
    }
    return "先锁定必去点，再补顺路景点。";
  }
  if (destinationAnchor.value && preferredDistrict.value) {
    return `从 ${origin.value.name} 出发，围绕 ${destinationAnchor.value}，优先落在 ${preferredDistrict.value}。`;
  }
  if (destinationAnchor.value) {
    return `从 ${origin.value.name} 出发，围绕 ${destinationAnchor.value} 排线。`;
  }
  if (preferredDistrict.value) {
    return `从 ${origin.value.name} 出发，优先在 ${preferredDistrict.value} 内排线。`;
  }
  if (planningRequest.value?.budget != null || planningRequest.value?.available_hours != null) {
    return "只给预算或时间，也能先出一版路线。";
  }
  return "填几个条件，先出候选方案。";
});

const planningRouteStyle = computed(() => {
  const availableHours = effectiveAvailableHours.value;
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

const planningSummary = computed(() => {
  if (!planningRequest.value) {
    return "输入后这里会显示候选方案。";
  }

  if (requestedMustVisits.value.length >= 2) {
    if (destinationAnchor.value && preferredDistrict.value) {
      return `优先串联 ${requestedMustVisits.value.join("、")}，再围绕 ${destinationAnchor.value} 补 ${preferredDistrict.value} 内的点。`;
    }
    if (destinationAnchor.value) {
      return `优先串联 ${requestedMustVisits.value.join("、")}，再围绕 ${destinationAnchor.value} 补点。`;
    }
    if (preferredDistrict.value) {
      return `优先串联 ${requestedMustVisits.value.join("、")}，再优先在 ${preferredDistrict.value} 内补点。`;
    }
    return `优先串联 ${requestedMustVisits.value.join("、")}。`;
  }
  if (requestedMustVisits.value.length === 1) {
    if (destinationAnchor.value && preferredDistrict.value) {
      return `先保证 ${requestedMustVisits.value[0]}，再围绕 ${destinationAnchor.value} 补 ${preferredDistrict.value} 内的点。`;
    }
    if (destinationAnchor.value) {
      return `先保证 ${requestedMustVisits.value[0]}，再围绕 ${destinationAnchor.value} 补点。`;
    }
    if (preferredDistrict.value) {
      return `先保证 ${requestedMustVisits.value[0]}，再优先在 ${preferredDistrict.value} 内补点。`;
    }
    return `先保证 ${requestedMustVisits.value[0]}，再自动补点。`;
  }
  if (destinationAnchor.value && preferredDistrict.value) {
    return `围绕 ${destinationAnchor.value}，优先在 ${preferredDistrict.value} 内生成 ${planningRouteStyle.value}。`;
  }
  if (destinationAnchor.value) {
    return `围绕 ${destinationAnchor.value} 生成 ${planningRouteStyle.value}。`;
  }
  if (preferredDistrict.value) {
    return `优先在 ${preferredDistrict.value} 内生成 ${planningRouteStyle.value}。`;
  }
  if (planningRequest.value.budget != null && planningRequest.value.available_hours == null) {
    return `按 ${effectiveBudget.value} 元预算自动规划。`;
  }
  if (planningRequest.value.available_hours != null && planningRequest.value.budget == null) {
    return `按 ${effectiveAvailableHours.value} 小时可玩时间自动规划。`;
  }

  return "按默认条件生成自由行路线。";
});
const interpretationNotes = computed(() => {
  const notes = [...appliedDefaults.value];
  if (matchedMustVisitNames.value.length) {
    notes.unshift(`已识别必去点：${matchedMustVisitNames.value.join("、")}`);
  }
  if (missingMustVisitNames.value.length) {
    notes.unshift(`暂未识别：${missingMustVisitNames.value.join("、")}`);
  }
  return notes;
});
const overviewChips = computed(() => {
  if (!planningRequest.value) {
    return [];
  }

  const chips = [`起点 ${origin.value.name}`];

  if (destinationAnchor.value) {
    chips.push(`目的地 ${destinationAnchor.value}`);
  }

  if (preferredDistrict.value) {
    chips.push(`片区 ${preferredDistrict.value}`);
  }

  if (requestedMustVisits.value.length) {
    chips.push(`必去 ${requestedMustVisits.value.join("、")}`);
  }

  if (planningRequest.value.budget != null) {
    chips.push(`${effectiveBudget.value} 元`);
  }

  if (planningRequest.value.available_hours != null) {
    chips.push(`${effectiveAvailableHours.value} 小时`);
  }

  return chips;
});

async function locateOrigin() {
  error.value = "";

  if (!navigator.geolocation) {
    error.value = "当前浏览器不支持定位。";
    return;
  }

  locatingOrigin.value = true;

  navigator.geolocation.getCurrentPosition(
    (position) => {
      origin.value = {
        name: "我的位置",
        latitude: Number(position.coords.latitude.toFixed(6)),
        longitude: Number(position.coords.longitude.toFixed(6))
      };
      locatingOrigin.value = false;
    },
    () => {
      error.value = "定位失败，请检查浏览器定位权限。";
      locatingOrigin.value = false;
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
  const preferredDistricts = payload.district_query ? [payload.district_query] : [];
  const inferredTravelDays = payload.available_hours == null ? null : payload.available_hours >= 11 ? 2 : 1;

  return {
    origin_name: originPoint.name,
    origin_latitude: originPoint.latitude,
    origin_longitude: originPoint.longitude,
    destination_name: destinationName || null,
    destination_latitude: anchorPoint?.latitude ?? null,
    destination_longitude: anchorPoint?.longitude ?? null,
    must_visit_names: payload.must_visit_names,
    budget: payload.budget,
    available_hours: payload.available_hours,
    travel_days: inferredTravelDays,
    preference_mode: payload.preference_mode,
    preferences: payload.preferences,
    preferred_districts: preferredDistricts,
    categories: [],
    special_interests: [],
    max_poi_count: payload.max_poi_count,
    max_transit_minutes_per_leg: payload.must_visit_names.length || destinationName || payload.district_query ? 90 : 75
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
  if (!destinationQuery.trim()) {
    return null;
  }

  try {
    return await geocodePlace(destinationQuery);
  } catch {
    return null;
  }
}

async function handleSubmit(payload: NavigationFormData) {
  const nextDestinationQuery = payload.destination_query.trim();
  const nextDistrictQuery = payload.district_query.trim();
  const nextMustVisits = payload.must_visit_names.map((item) => item.trim()).filter(Boolean);
  const normalizedPayload: NavigationFormData = {
    ...payload,
    destination_query: nextDestinationQuery,
    district_query: nextDistrictQuery,
    must_visit_names: nextMustVisits
  };

  loading.value = true;
  error.value = "";
  planningRequest.value = normalizedPayload;
  destinationAnchor.value = nextDestinationQuery;
  preferredDistrict.value = nextDistrictQuery;
  routeOptions.value = [];
  recommendedRoute.value = null;
  appliedDefaults.value = [];
  matchedMustVisitNames.value = [];
  missingMustVisitNames.value = [];

  try {
    const [nextOrigin, nextDestinationPoint] = await Promise.all([
      resolveOriginPoint(payload.origin_query),
      resolveDestinationPoint(nextDestinationQuery)
    ]);

    origin.value = nextOrigin;

    const recommendationPayload = buildRecommendationPayload(
      normalizedPayload,
      nextOrigin,
      nextDestinationQuery,
      nextDestinationPoint
    );
    const recommendation = await getRecommendations(recommendationPayload);
    appliedDefaults.value = recommendation.applied_defaults;
    matchedMustVisitNames.value = recommendation.matched_must_visit_names;
    missingMustVisitNames.value = recommendation.missing_must_visit_names;
    routeOptions.value = recommendation.route_options;
    recommendedRoute.value = pickRoute(normalizedPayload.preference_mode, recommendation.route_options);
    if (!recommendedRoute.value) {
      if (recommendation.missing_must_visit_names.length) {
        error.value = `暂未识别这些必去点：${recommendation.missing_must_visit_names.join("、")}。`;
      } else if (nextMustVisits.length) {
        error.value = `当前预算和时长下，暂时无法把 ${nextMustVisits.join("、")} 串成可用游玩线。`;
      } else if (nextDestinationQuery) {
        error.value = `围绕 ${nextDestinationQuery} 暂未生成可用游玩线。`;
      } else if (nextDistrictQuery) {
        error.value = `在 ${nextDistrictQuery} 内暂未生成可用游玩线。`;
      } else {
        error.value = "当前条件下暂未生成可用游玩线，请放宽预算、时长或减少必去点。";
      }
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
    <section class="hero-panel panel">
      <div class="hero-grid">
        <div class="hero-copy">
          <span class="hero-kicker"><AppIcon name="spark" />STREE Trip Concierge</span>
          <h1>{{ heroTitle }}</h1>
          <p>{{ heroDescription }}</p>
        </div>
      </div>
    </section>

    <PreferenceForm :loading="loading" :initial-origin="origin" @submit="handleSubmit" @locate-origin="locateOrigin" />

    <div v-if="error" class="status-bar status-error">
      {{ error }}
    </div>
    <div v-else-if="loading" class="status-bar">
      正在解析地点并生成路线...
    </div>
    <div v-else-if="locatingOrigin" class="status-bar">
      正在获取当前位置，不影响直接生成游玩路线。
    </div>

    <div class="workspace-shell">
      <div class="workspace-main">
        <section v-if="recommendedRoute" class="panel stat-panel">
          <article v-for="stat in routeStats" :key="stat.label" class="stat-card">
            <span class="stat-card-label"><AppIcon :name="stat.icon" />{{ stat.label }}</span>
            <strong>{{ stat.value }}</strong>
            <small>{{ stat.hint }}</small>
          </article>
        </section>

        <section v-if="planningRequest" class="panel overview-panel">
          <div class="overview-header">
            <div class="overview-copy-block">
              <span class="section-kicker">候选方案</span>
              <strong>{{ recommendedRoute?.title ?? planningModeLabel }}</strong>
            </div>

            <span :class="['route-style-pill', { 'route-style-muted': !recommendedRoute }]">
              {{ recommendedRoute?.route_style ?? planningRouteStyle }}
            </span>
          </div>

          <div v-if="overviewChips.length" class="stop-chip-row">
            <span v-for="chip in overviewChips" :key="chip" class="stop-chip">{{ chip }}</span>
          </div>

          <p v-if="!recommendedRoute" class="overview-copy">{{ planningSummary }}</p>

          <div v-if="interpretationNotes.length" class="stop-chip-row">
            <span v-for="note in interpretationNotes" :key="note" class="stop-chip">{{ note }}</span>
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
              <span class="section-kicker">建议时段</span>
              <strong>{{ recommendedRoute.title }}</strong>
            </div>
            <span class="route-style-pill">{{ recommendedRoute.route_style }}</span>
          </div>

          <div class="itinerary-grid">
            <article
              v-for="item in recommendedRoute.itinerary"
              :key="`${item.day_index}-${item.poi_name}-${item.start_time}`"
              class="itinerary-item"
            >
              <span class="itinerary-day">Day {{ item.day_index }}</span>
              <strong>{{ item.start_time }} - {{ item.end_time }}</strong>
              <span>{{ item.poi_name }}</span>
              <small>停留 {{ item.stay_hours }} 小时 · 接驳 {{ item.transit_minutes_from_previous }} 分钟</small>
            </article>
          </div>
        </section>

        <section v-if="stopHighlights.length" class="panel explanation-panel">
          <div class="itinerary-header">
            <div>
              <span class="section-kicker">补点解释</span>
              <strong>为什么是这些点</strong>
            </div>
          </div>

          <div class="explanation-grid">
            <article v-for="item in stopHighlights" :key="item.poi_name" class="explanation-card">
              <div class="explanation-card-head">
                <strong>{{ item.poi_name }}</strong>
                <span class="route-style-pill route-style-muted">{{ item.reason_title }}</span>
              </div>
              <p>{{ item.reason_body }}</p>
              <div v-if="item.tags.length" class="stop-chip-row explanation-chip-row">
                <span v-for="tag in item.tags" :key="`${item.poi_name}-${tag}`" class="stop-chip">{{ tag }}</span>
              </div>
            </article>
          </div>
        </section>

        <section v-else class="panel itinerary-panel placeholder-panel">
          <div class="placeholder-copy">
            <span class="section-kicker">行程结果</span>
            <strong>
              {{ planningRequest ? `正在生成 ${planningModeLabel}` : "输入必去景点、区域或预算开始推荐" }}
            </strong>
          </div>
        </section>
      </div>

      <aside class="workspace-side">
        <section class="panel journey-panel">
          <div class="journey-panel-header">
            <div>
              <span class="section-kicker">当前摘要</span>
              <strong>{{ planningRequest ? planningModeLabel : "等待输入" }}</strong>
            </div>
            <span :class="['route-style-pill', { 'route-style-muted': !recommendedRoute }]">
              {{ recommendedRoute?.route_style ?? "等待生成" }}
            </span>
          </div>

          <div class="journey-line">
            <span><AppIcon name="pin" />起点</span>
            <strong>{{ origin.name }}</strong>
          </div>
          <div class="journey-line">
            <span><AppIcon name="briefcase" />规划方式</span>
            <strong>{{ planningModeLabel }}</strong>
          </div>
          <div class="journey-line">
            <span><AppIcon name="map" />想去哪一带</span>
            <strong>{{ destinationAnchor || "未限定片区" }}</strong>
          </div>
          <div class="journey-line">
            <span><AppIcon name="waypoint" />必去景点</span>
            <strong>{{ requestedMustVisits.length ? requestedMustVisits.join("、") : "未指定" }}</strong>
          </div>
          <div v-if="stopNames.length" class="journey-stop-list">
            <span v-for="name in stopNames" :key="name" class="journey-stop-chip">{{ name }}</span>
          </div>
          <p v-else-if="missingMustVisitNames.length" class="journey-empty">
            这些必去点暂未识别：{{ missingMustVisitNames.join("、") }}。
          </p>
        </section>

        <section class="map-panel panel">
          <div class="map-panel-header">
            <div class="map-panel-copy">
              <strong><AppIcon name="map" />地图辅助视图</strong>
            </div>

            <div v-if="recommendedRoute" class="transport-switcher">
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
          </div>

          <RouteMap :origin="origin" :stops="routeStops" :mode="routeMode" />
        </section>
      </aside>
    </div>
  </main>
</template>

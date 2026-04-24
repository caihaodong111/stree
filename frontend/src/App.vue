<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { getRecommendations, planByAIWithDraft } from "./api/client";
import AppIcon from "./components/AppIcon.vue";
import PreferenceForm from "./components/PreferenceForm.vue";
import RouteCard from "./components/RouteCard.vue";
import RouteMap from "./components/RouteMap.vue";
import type { LocationPoint, NavigationFormData, RecommendationRequest, RouteOption } from "./types";

const DEFAULT_BUDGET = 600;
const DEFAULT_AVAILABLE_HOURS = 8;
const HOURS_PER_DAY = 8;

const loading = ref(false);
const locatingOrigin = ref(false);
const error = ref("");
const routeMode = ref<"walking" | "driving" | "transfer">("walking");
const origin = ref<LocationPoint>({
  name: "天安门东",
  latitude: 39.9087,
  longitude: 116.3975
});
const planningRequest = ref<NavigationFormData | null>(null);
const aiNormalizedRequest = ref<RecommendationRequest | null>(null);
const routeOptions = ref<RouteOption[]>([]);
const recommendedRoute = ref<RouteOption | null>(null);
const recommendationSummary = ref("");
const appliedDefaults = ref<string[]>([]);
const matchedMustVisitNames = ref<string[]>([]);
const missingMustVisitNames = ref<string[]>([]);
const aiAssistantReply = ref("");
const aiFallbackUsed = ref(false);
const aiModelLabel = ref("");
const aiParserNotes = ref<string[]>([]);
const routeGenerationSource = ref<"ai_generated" | "rule_fallback" | "">("");
const routeGenerationNote = ref("");

const routeStops = computed<LocationPoint[]>(() => {
  const itinerary = recommendedRoute.value?.itinerary ?? [];
  const stops = itinerary
    .filter((item) => item.latitude != null && item.longitude != null)
    .map((item) => ({
      name: item.poi_name,
      latitude: Number(item.latitude),
      longitude: Number(item.longitude)
    }));

  if (stops.length) {
    return stops;
  }

  return recommendedRoute.value?.pois.map((poi) => ({
    name: poi.name,
    latitude: poi.latitude,
    longitude: poi.longitude
  })) ?? [];
});

const stopHighlights = computed(() => recommendedRoute.value?.stop_highlights ?? []);
const stopNames = computed(() => routeStops.value.map((stop) => stop.name));
const routeGenerationLabel = computed(() => {
  if (routeGenerationSource.value === "ai_generated") {
    return "AI 选点 + 代码校验";
  }
  if (routeGenerationSource.value === "rule_fallback") {
    return "规则选点兜底";
  }
  return "等待生成";
});
const requestedMustVisits = computed(() => planningRequest.value?.must_visit_names ?? []);
const effectiveMustVisits = computed(() => aiNormalizedRequest.value?.must_visit_names ?? requestedMustVisits.value);
const requestedPreferredDistricts = computed(() => planningRequest.value?.preferred_districts ?? []);
const effectivePreferredDistricts = computed(() => aiNormalizedRequest.value?.preferred_districts ?? requestedPreferredDistricts.value);
const effectiveBudget = computed(() => aiNormalizedRequest.value?.budget ?? planningRequest.value?.budget ?? DEFAULT_BUDGET);
const effectiveAvailableHours = computed(
  () => aiNormalizedRequest.value?.available_hours ?? planningRequest.value?.available_hours ?? DEFAULT_AVAILABLE_HOURS
);
const effectiveTravelDays = computed(() => {
  if (aiNormalizedRequest.value?.travel_days != null) {
    return aiNormalizedRequest.value.travel_days;
  }
  if (planningRequest.value?.travel_days != null) {
    return planningRequest.value.travel_days;
  }
  const hours = aiNormalizedRequest.value?.available_hours ?? planningRequest.value?.available_hours;
  if (hours == null) {
    return null;
  }
  return Math.max(1, Math.round(hours / HOURS_PER_DAY));
});
const planningModeLabel = computed(() => {
  const hasDistrict = effectivePreferredDistricts.value.length > 0;
  const mustVisitCount = effectiveMustVisits.value.length;
  const request = aiNormalizedRequest.value ?? planningRequest.value;

  if (mustVisitCount >= 2) {
    return hasDistrict ? "必去点串联 + 片区补点" : "多必去点串联";
  }
  if (mustVisitCount === 1) {
    return hasDistrict ? "单必去点 + 片区补点" : "单必去点规划";
  }
  if (hasDistrict) {
    return "片区偏好规划";
  }
  if (request?.budget != null && request.travel_days == null) {
    return "预算导向自动规划";
  }
  if (request?.travel_days != null && request.budget == null) {
    return "天数导向自动规划";
  }
  if (request?.budget != null && request.travel_days != null) {
    return "条件组合规划";
  }
  return "自由探索规划";
});
const routeStats = computed(() => {
  if (!recommendedRoute.value) {
    return [];
  }

  const dayCount = new Set(recommendedRoute.value.itinerary.map((item) => item.day_index)).size || 1;
  const stationPreview = stopNames.value.slice(0, 6);
  const remainingStationCount = Math.max(0, stopNames.value.length - stationPreview.length);

  return [
    {
      icon: "wallet" as const,
      label: "预计预算",
      value: `${recommendedRoute.value.total_budget_with_hotel ?? recommendedRoute.value.total_budget} 元`,
      hint: recommendedRoute.value.estimated_accommodation_budget > 0 ? "含门票、餐饮、交通与住宿估算" : "含门票、餐饮与交通估算",
      chips: [] as string[],
      extraCount: 0
    },
    {
      icon: "clock" as const,
      label: "总时长",
      value: `${recommendedRoute.value.total_duration_hours} 小时`,
      hint: `${dayCount} 天内可完成`,
      chips: [] as string[],
      extraCount: 0
    },
    {
      icon: "route" as const,
      label: "空间跨度",
      value: `${recommendedRoute.value.total_travel_km} km`,
      hint: "适合先看地图再决定节奏",
      chips: [] as string[],
      extraCount: 0
    },
    {
      icon: "waypoint" as const,
      label: "推荐站点",
      value: recommendedRoute.value.estimated_accommodation_budget > 0
        ? `${recommendedRoute.value.pois.length} 景点 / ${(recommendedRoute.value.recommended_hotels ?? []).length} 晚住宿`
        : `${recommendedRoute.value.pois.length} 个`,
      hint: recommendedRoute.value.estimated_accommodation_budget > 0 ? "景点与每晚住宿已一起考虑" : "已含必去点与顺路补点",
      chips: stationPreview,
      extraCount: remainingStationCount
    }
  ];
});
const heroTitle = computed(() => {
  const mustVisits = effectiveMustVisits.value;
  if (mustVisits.length >= 2) {
    return `把 ${mustVisits.slice(0, 2).join(" 和 ")} 串进一条顺手的路线`;
  }
  if (mustVisits.length === 1 && effectivePreferredDistricts.value.length) {
    return `先保证 ${mustVisits[0]}，再优先补 ${effectivePreferredDistricts.value[0]} 内的顺路景点`;
  }
  if (mustVisits.length === 1) {
    return `先保证 ${mustVisits[0]}，再自动补顺路景点`;
  }
  if (effectivePreferredDistricts.value.length) {
    return `优先在 ${effectivePreferredDistricts.value[0]} 内生成更顺手的游玩线`;
  }
  if (planningRequest.value?.budget != null && planningRequest.value.travel_days == null) {
    return "按预算收一条更合适的路线";
  }
  if (planningRequest.value?.travel_days != null && planningRequest.value.budget == null) {
    return "按天数收一条更顺手的路线";
  }
  return "把想去的地方，排成一条顺路的城市线";
});
const heroDescription = computed(() => {
  if (effectiveMustVisits.value.length) {
    if (effectivePreferredDistricts.value.length) {
      return "先锁定必去点，再优先在偏好片区里补点。";
    }
    return "先锁定必去点，再补顺路景点。";
  }
  if (effectivePreferredDistricts.value.length) {
    return `从 ${origin.value.name} 出发，优先在 ${effectivePreferredDistricts.value[0]} 内排线。`;
  }
  if (planningRequest.value?.budget != null || planningRequest.value?.travel_days != null) {
    return "只给时间或预算，也能先出一版。";
  }
  return "输入必去景点、偏好区域和时间预算，系统会先给出可落到地图上的 AI 方案。";
});

const planningSummary = computed(() => {
  if (!planningRequest.value) {
    return "输入后这里会显示候选方案。";
  }

  if (effectiveMustVisits.value.length >= 2) {
    if (effectivePreferredDistricts.value.length) {
      return `优先串联 ${effectiveMustVisits.value.join("、")}，再优先在 ${effectivePreferredDistricts.value[0]} 内补点。`;
    }
    return `优先串联 ${effectiveMustVisits.value.join("、")}。`;
  }
  if (effectiveMustVisits.value.length === 1) {
    if (effectivePreferredDistricts.value.length) {
      return `先保证 ${effectiveMustVisits.value[0]}，再优先在 ${effectivePreferredDistricts.value[0]} 内补点。`;
    }
    return `先保证 ${effectiveMustVisits.value[0]}，再自动补点。`;
  }
  if (effectivePreferredDistricts.value.length) {
    return `优先在 ${effectivePreferredDistricts.value[0]} 内生成一条顺路游玩线。`;
  }
  if (planningRequest.value.budget != null && planningRequest.value.travel_days == null) {
    return `按 ${effectiveBudget.value} 元预算自动规划。`;
  }
  if (planningRequest.value.travel_days != null && planningRequest.value.budget == null) {
    return `按 ${effectiveTravelDays.value} 天可玩时间自动规划。`;
  }

  return "按默认条件生成自由行路线。";
});
const interpretationNotes = computed(() => {
  const notes = [...appliedDefaults.value];
  if (routeGenerationSource.value) {
    notes.unshift(`路线生成：${routeGenerationLabel.value}`);
  }
  if (aiModelLabel.value) {
    notes.unshift(`AI 解析：${aiModelLabel.value}${aiFallbackUsed.value ? "（已回退规则解析）" : ""}`);
  }
  if (matchedMustVisitNames.value.length) {
    notes.unshift(`已识别必去点：${matchedMustVisitNames.value.join("、")}`);
  }
  if (missingMustVisitNames.value.length) {
    notes.unshift(`暂未识别：${missingMustVisitNames.value.join("、")}`);
  }
  return [...notes, ...aiParserNotes.value];
});
const overviewChips = computed(() => {
  if (!planningRequest.value) {
    return [];
  }

  const chips = [`起点 ${origin.value.name}`];

  if (effectivePreferredDistricts.value.length) {
    chips.push(`片区 ${effectivePreferredDistricts.value.join("、")}`);
  }

  if (effectiveMustVisits.value.length) {
    chips.push(`必去 ${effectiveMustVisits.value.join("、")}`);
  }

  if (planningRequest.value.budget != null) {
    chips.push(`${effectiveBudget.value} 元`);
  }

  if (planningRequest.value.travel_days != null && effectiveTravelDays.value != null) {
    chips.push(`${effectiveTravelDays.value} 天`);
  }

  return chips;
});

const itineraryDays = computed(() => {
  const itinerary = recommendedRoute.value?.itinerary ?? [];
  const dayMap = new Map<number, typeof itinerary>();

  itinerary.forEach((item) => {
    const currentDay = dayMap.get(item.day_index) ?? [];
    currentDay.push(item);
    dayMap.set(item.day_index, currentDay);
  });

  return Array.from(dayMap.entries())
    .sort(([dayA], [dayB]) => dayA - dayB)
    .map(([dayIndex, items]) => ({
      dayIndex,
      items
    }));
});

function formatStayHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function formatReferencePrice(price: number | null) {
  if (price == null) {
    return "价格待补充";
  }
  return `参考价 ${price} 元`;
}

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
  originPoint: LocationPoint
): RecommendationRequest {
  return {
    origin_name: originPoint.name,
    origin_latitude: originPoint.latitude,
    origin_longitude: originPoint.longitude,
    destination_name: null,
    destination_latitude: null,
    destination_longitude: null,
    must_visit_names: payload.must_visit_names,
    budget: payload.budget,
    available_hours: payload.available_hours,
    travel_days: payload.travel_days,
    preference_mode: payload.preference_mode,
    preferences: payload.preferences,
    preferred_districts: payload.preferred_districts,
    categories: [],
    special_interests: [],
    max_poi_count: null,
    max_transit_minutes_per_leg: null
  };
}

function buildAIUserMessage(payload: NavigationFormData, originPoint: LocationPoint): string {
  const parts = [`我想从${originPoint.name}出发规划北京行程`];

  if (payload.must_visit_names.length) {
    parts.push(`必去景点是${payload.must_visit_names.join("、")}`);
  }
  if (payload.preferred_districts.length) {
    parts.push(`优先考虑${payload.preferred_districts.join("、")}`);
  }
  if (payload.budget != null) {
    parts.push(`预算${payload.budget}元`);
  }
  if (payload.travel_days != null) {
    parts.push(`可玩${payload.travel_days}天`);
  }
  if (payload.preference_mode === "time_first") {
    parts.push("尽量省时");
  } else if (payload.preference_mode === "richness_first") {
    parts.push("想多看一些点");
  } else {
    parts.push("整体均衡一些");
  }
  if (payload.preferences.favor_low_budget) {
    parts.push("尽量省钱");
  }
  if (payload.preferences.favor_photography) {
    parts.push("偏好拍照");
  }
  if (payload.preferences.avoid_crowds) {
    parts.push("尽量避开人多");
  }

  return `${parts.join("，")}。`;
}

function pickRoute(preferenceMode: NavigationFormData["preference_mode"], routes: RouteOption[]): RouteOption | null {
  if (!routes.length) {
    return null;
  }

  return (
    routes.find((route) => route.option_id === preferenceMode) ??
    routes.find((route) => route.strategy === preferenceMode) ??
    routes[0]
  );
}

function selectRoute(route: RouteOption) {
  recommendedRoute.value = route;
}

async function handleSubmit(payload: NavigationFormData) {
  if (payload.travel_days == null) {
    error.value = "生成路线前请先选择天数。";
    return;
  }

  const nextPreferredDistricts = payload.preferred_districts.map((item) => item.trim()).filter(Boolean);
  const nextMustVisits = payload.must_visit_names.map((item) => item.trim()).filter(Boolean);
  const normalizedPayload: NavigationFormData = {
    ...payload,
    preferred_districts: Array.from(new Set(nextPreferredDistricts)),
    must_visit_names: nextMustVisits
  };

  loading.value = true;
  error.value = "";
  planningRequest.value = normalizedPayload;
  routeOptions.value = [];
  recommendedRoute.value = null;
  recommendationSummary.value = "";
  appliedDefaults.value = [];
  matchedMustVisitNames.value = [];
  missingMustVisitNames.value = [];
  aiAssistantReply.value = "";
  aiFallbackUsed.value = false;
  aiModelLabel.value = "";
  aiParserNotes.value = [];
  routeGenerationSource.value = "";
  routeGenerationNote.value = "";
  aiNormalizedRequest.value = null;

  try {
    const recommendationPayload = buildRecommendationPayload(normalizedPayload, origin.value);
    const aiPlanning = await planByAIWithDraft({
      user_message: buildAIUserMessage(normalizedPayload, origin.value),
      draft_request: recommendationPayload
    });
    aiAssistantReply.value = aiPlanning.assistant_reply;
    aiFallbackUsed.value = aiPlanning.fallback_used;
    aiModelLabel.value = `${aiPlanning.provider} / ${aiPlanning.model}`;
    aiParserNotes.value = aiPlanning.parser_notes;
    aiNormalizedRequest.value = aiPlanning.normalized_request;

    const recommendation = await getRecommendations(aiPlanning.normalized_request);
    recommendationSummary.value = recommendation.recommendation_summary;
    routeGenerationSource.value = recommendation.route_generation_source;
    routeGenerationNote.value = recommendation.route_generation_note ?? "";
    appliedDefaults.value = recommendation.applied_defaults;
    matchedMustVisitNames.value = recommendation.matched_must_visit_names;
    missingMustVisitNames.value = recommendation.missing_must_visit_names;
    routeOptions.value = recommendation.route_options;
    recommendedRoute.value = pickRoute(aiPlanning.normalized_request.preference_mode, recommendation.route_options);
    if (!recommendedRoute.value) {
      if (recommendation.missing_must_visit_names.length) {
        error.value = `暂未识别这些必去点：${recommendation.missing_must_visit_names.join("、")}。`;
      } else if (aiPlanning.normalized_request.must_visit_names.length) {
        error.value = `暂时无法把 ${aiPlanning.normalized_request.must_visit_names.join("、")} 串成可用游玩线。你可以继续保留这些必去点，或补充预算、时长、区域等条件让我缩小搜索范围。`;
      } else if (aiPlanning.normalized_request.preferred_districts.length) {
        error.value = `在 ${aiPlanning.normalized_request.preferred_districts.join("、")} 内暂未生成可用游玩线。`;
      } else {
        error.value = "当前条件下暂未生成可用游玩线。你可以补充预算、时长、区域或必去点，让系统进一步收敛方案。";
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
          <span class="hero-kicker"><AppIcon name="spark" />智悦规划</span>
          <h1>基于 AI 的智能旅游规划系统</h1>
          <strong class="hero-lead">{{ heroTitle }}</strong>
          <p>{{ heroDescription }}</p>
        </div>
      </div>
    </section>

    <PreferenceForm class="planning-form-card" :loading="loading" @submit="handleSubmit" />

    <div v-if="error" class="status-bar status-error">
      {{ error }}
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
            <div v-if="stat.chips.length" class="stat-card-chip-scroll" :aria-label="`${stat.label}预览`">
              <span v-for="chip in stat.chips" :key="`${stat.label}-${chip}`" class="stat-card-chip">{{ chip }}</span>
              <span v-if="stat.extraCount" class="stat-card-chip stat-card-chip-more">+{{ stat.extraCount }}</span>
            </div>
          </article>
        </section>

        <section v-if="planningRequest" class="panel overview-panel">
          <div class="overview-header">
            <div class="overview-copy-block">
              <span class="section-kicker">候选方案</span>
              <strong>{{ recommendedRoute?.title ?? planningModeLabel }}</strong>
            </div>
          </div>

          <div v-if="overviewChips.length" class="stop-chip-row">
            <span v-for="chip in overviewChips" :key="chip" class="stop-chip">{{ chip }}</span>
          </div>

          <p v-if="!recommendedRoute" class="overview-copy">{{ planningSummary }}</p>

          <p v-if="recommendationSummary" class="overview-copy">
            {{ recommendationSummary }}
          </p>

          <p v-if="recommendedRoute?.highlight_reason" class="overview-copy">
            {{ recommendedRoute.highlight_reason }}
          </p>

          <p v-if="aiAssistantReply" class="overview-copy">
            {{ aiAssistantReply }}
          </p>

          <p v-if="routeGenerationNote" class="overview-copy">
            {{ routeGenerationNote }}
          </p>

          <div v-if="interpretationNotes.length" class="stop-chip-row">
            <span v-for="note in interpretationNotes" :key="note" class="stop-chip">{{ note }}</span>
          </div>

          <div v-if="routeOptions.length" class="route-card-row">
            <RouteCard
              v-for="route in routeOptions"
              :key="route.option_id"
              :route="route"
              :selected="recommendedRoute?.option_id === route.option_id"
              @select="selectRoute(route)"
            />
          </div>
        </section>

        <section v-if="recommendedRoute" class="panel itinerary-panel">
          <div class="itinerary-header">
            <div>
              <span class="section-kicker">建议时段</span>
              <strong>{{ recommendedRoute.title }}</strong>
              <p>按每天的时间顺序查看停留地点、住宿位置和站点间接驳时间。</p>
            </div>
          </div>

          <div class="itinerary-scroll">
            <section v-for="day in itineraryDays" :key="`day-${day.dayIndex}`" class="itinerary-day-block">
              <div class="itinerary-day-head">
                <span class="itinerary-day-badge">Day {{ day.dayIndex }}</span>
                <small>{{ day.items.length }} 个停留点</small>
              </div>

              <div class="itinerary-day-track" :aria-label="`Day ${day.dayIndex} 行程时间线`">
                <template v-for="(item, index) in day.items" :key="`${day.dayIndex}-${item.poi_name}-${item.start_time}`">
                  <article :class="['itinerary-stop-card', { 'itinerary-stop-card-hotel': item.item_type === 'hotel' }]">
                    <strong>{{ item.start_time }} - {{ item.end_time }}</strong>
                    <span class="itinerary-stop-name">{{ item.poi_name }}</span>
                    <small v-if="item.item_type === 'hotel'">
                      住宿位置 · {{ formatReferencePrice(item.reference_price) }}
                    </small>
                    <small v-else>停留 {{ formatStayHours(item.stay_hours) }} 小时</small>
                  </article>

                  <div v-if="index < day.items.length - 1" class="itinerary-leg">
                    <span>接驳 {{ day.items[index + 1].transit_minutes_from_previous }} 分钟</span>
                  </div>
                </template>
              </div>
            </section>
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

<script setup lang="ts">
import AppIcon from "./AppIcon.vue";
import type { RouteOption } from "../types";

const emit = defineEmits<{
  select: [];
}>();

const props = defineProps<{
  route: RouteOption;
  selected?: boolean;
}>();

function strategyLabel(strategy: string) {
  if (strategy === "time_first") {
    return "时间优先";
  }
  if (strategy === "richness_first") {
    return "丰富度优先";
  }
  return "均衡推荐";
}

function stopPreview(route: RouteOption) {
  return route.pois.slice(0, 3).map((poi) => poi.name).join(" · ");
}
</script>

<template>
  <button :class="['route-tab-card', { selected }]" type="button" @click="emit('select')">
    <div class="route-card-head">
      <span class="route-card-badge">
        <AppIcon name="briefcase" />
        {{ strategyLabel(route.strategy) }}
      </span>
      <span class="route-card-metric">
        <AppIcon name="route" />
        {{ route.total_travel_km }} km
      </span>
    </div>
    <div class="route-card-title-row">
      <strong>{{ route.title }}</strong>
      <span class="route-card-score">Score {{ route.score }}</span>
    </div>
    <span class="route-card-subtitle">{{ route.route_style }}</span>
    <p class="route-card-copy">{{ route.highlight_reason }}</p>
    <div class="route-card-quote">
      <div class="route-card-quote-head">
        <span>方案报价单</span>
        <small>Included</small>
      </div>
      <div class="route-card-quote-row">
        <span><AppIcon name="wallet" />预计花费</span>
        <strong>{{ route.total_budget }} 元</strong>
      </div>
      <div class="route-card-quote-row">
        <span><AppIcon name="clock" />时间成本</span>
        <strong>{{ route.total_duration_hours }} 小时</strong>
      </div>
      <div class="route-card-quote-row">
        <span><AppIcon name="waypoint" />包含点位</span>
        <strong>{{ route.pois.length }} 个</strong>
      </div>
    </div>
    <small class="route-card-footer">
      <AppIcon name="route" />
      推荐顺序 · {{ stopPreview(route) }}
    </small>
  </button>
</template>

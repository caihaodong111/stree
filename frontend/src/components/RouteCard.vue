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

function stopPreview(route: RouteOption) {
  return route.pois.slice(0, 3).map((poi) => poi.name).join(" · ");
}

function budgetLabel(route: RouteOption) {
  if (route.total_budget_with_hotel != null && route.estimated_accommodation_budget > 0) {
    return `${route.total_budget_with_hotel} 元`;
  }
  return `${route.total_budget} 元`;
}
</script>

<template>
  <button :class="['route-tab-card', { selected }]" type="button" @click="emit('select')">
    <div class="route-card-head">
      <span class="route-card-badge">
        <AppIcon name="briefcase" />
        {{ route.option_label }}
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
    <p class="route-card-copy">{{ route.highlight_reason }}</p>
    <div class="route-card-quote">
      <div class="route-card-quote-head">
        <span>方案报价单</span>
        <small>Included</small>
      </div>
      <div class="route-card-quote-row">
        <span><AppIcon name="wallet" />预计花费</span>
        <strong>{{ budgetLabel(route) }}</strong>
      </div>
      <div v-if="route.estimated_accommodation_budget > 0" class="route-card-quote-row">
        <span><AppIcon name="briefcase" />住宿参考</span>
        <strong>{{ route.estimated_accommodation_budget }} 元</strong>
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

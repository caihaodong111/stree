<script setup lang="ts">
import type { RouteOption } from "../types";

const emit = defineEmits<{
  select: [];
}>();

defineProps<{
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
</script>

<template>
  <button :class="['route-tab-card', { selected }]" type="button" @click="emit('select')">
    <strong>{{ route.title }}</strong>
    <span>{{ route.route_style }} · {{ strategyLabel(route.strategy) }}</span>
    <small>{{ route.total_budget }} 元 · {{ route.total_duration_hours }} 小时 · {{ route.total_travel_km }} km</small>
  </button>
</template>

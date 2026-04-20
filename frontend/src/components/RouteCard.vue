<script setup lang="ts">
import type { RouteOption } from "../types";

const emit = defineEmits<{
  select: [];
}>();

defineProps<{
  route: RouteOption;
  selected?: boolean;
}>();
</script>

<template>
  <button :class="['route-tab-card', { selected }]" type="button" @click="emit('select')">
    <strong>{{ route.title }}</strong>
    <span>{{ route.strategy }}</span>
    <small>{{ route.total_budget }} 元 · {{ route.total_duration_hours }} 小时 · {{ route.total_travel_km }} km</small>
  </button>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { LocationPoint, NavigationFormData, PreferenceInput } from "../types";

const props = defineProps<{
  loading?: boolean;
  initialOrigin?: LocationPoint;
}>();

const emit = defineEmits<{
  submit: [payload: NavigationFormData];
  locateOrigin: [];
}>();

const originInput = ref("我的位置");
const destinationInput = ref("");
const budget = ref(600);
const availableHours = ref(8);
const maxPoiCount = ref(3);
const showAdvanced = ref(false);
const preferenceMode = ref<"balanced" | "time_first" | "richness_first">("balanced");
const preferences = ref<PreferenceInput>({
  mode: "balanced",
  favor_low_budget: false,
  favor_photography: true,
  avoid_crowds: false
});

const canSubmit = computed(() => Boolean(destinationInput.value.trim()) && !props.loading);
const submitLabel = computed(() => {
  if (props.loading) {
    return "生成中";
  }
  if (!destinationInput.value.trim()) {
    return "先输入核心景点";
  }
  return "生成游玩线";
});

watch(
  () => props.initialOrigin,
  (value) => {
    if (!value) {
      return;
    }

    if (!originInput.value || originInput.value === "我的位置") {
      originInput.value = value.name;
    }
  },
  { immediate: true, deep: true }
);

function submitForm() {
  if (!destinationInput.value.trim()) {
    return;
  }

  preferences.value.mode = preferenceMode.value;

  emit("submit", {
    origin_query: originInput.value.trim() || "我的位置",
    destination_query: destinationInput.value.trim(),
    budget: budget.value,
    available_hours: availableHours.value,
    preference_mode: preferenceMode.value,
    preferences: structuredClone(preferences.value),
    max_poi_count: maxPoiCount.value
  });
}
</script>

<template>
  <section class="topbar panel">
    <div class="topbar-row">
      <label class="field-group">
        <span class="field-label">出发地</span>
        <input v-model="originInput" type="text" placeholder="默认我的位置，也可输入酒店、地铁站、商圈" />
      </label>

      <label class="field-group">
        <span class="field-label">核心景点 / 想去哪一带</span>
        <input v-model="destinationInput" type="text" placeholder="例如 故宫、国贸、什刹海、颐和园" />
        <small class="field-hint">系统会围绕这里推荐游玩线，而不是做点对点导航。</small>
      </label>

      <button class="secondary-button" type="button" @click="emit('locateOrigin')">
        当前位置
      </button>

      <button class="secondary-button" type="button" @click="showAdvanced = !showAdvanced">
        {{ showAdvanced ? "收起偏好" : "预算 / 时长 / 偏好" }}
      </button>

      <button class="primary" type="button" :disabled="!canSubmit" @click="submitForm">
        {{ submitLabel }}
      </button>
    </div>

    <div v-if="showAdvanced" class="advanced-panel">
      <div class="topbar-row advanced-row">
        <label class="field-group field-group-compact">
          <span class="field-label">预算</span>
          <input v-model.number="budget" type="number" min="100" step="50" placeholder="例如 600 元" />
        </label>

        <label class="field-group field-group-compact">
          <span class="field-label">可玩时长</span>
          <input v-model.number="availableHours" type="number" min="2" max="18" placeholder="例如 8 小时" />
        </label>

        <label class="field-group field-group-compact">
          <span class="field-label">推荐景点数</span>
          <input v-model.number="maxPoiCount" type="number" min="1" max="5" placeholder="例如 3" />
        </label>
      </div>

      <div class="advanced-row">
        <div class="mode-switch">
          <button
            type="button"
            :class="['mode-chip', { active: preferenceMode === 'balanced' }]"
            @click="preferenceMode = 'balanced'"
          >
            均衡
          </button>
          <button
            type="button"
            :class="['mode-chip', { active: preferenceMode === 'time_first' }]"
            @click="preferenceMode = 'time_first'"
          >
            时间优先
          </button>
          <button
            type="button"
            :class="['mode-chip', { active: preferenceMode === 'richness_first' }]"
            @click="preferenceMode = 'richness_first'"
          >
            丰富度优先
          </button>
        </div>

        <div class="toggle-row">
          <label class="toggle-item">
            <input v-model="preferences.favor_low_budget" type="checkbox" />
            <span>省钱</span>
          </label>
          <label class="toggle-item">
            <input v-model="preferences.favor_photography" type="checkbox" />
            <span>拍照</span>
          </label>
          <label class="toggle-item">
            <input v-model="preferences.avoid_crowds" type="checkbox" />
            <span>避开人群</span>
          </label>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getPoiSuggestions } from "../api/client";
import AppIcon from "./AppIcon.vue";
import {
  buildSuggestionCatalog,
  emptySuggestionCatalog,
  filterPlaceSuggestions,
  type PlaceSuggestion
} from "../data/placeSuggestions";
import type { NavigationFormData, PreferenceInput } from "../types";

type SuggestionField = "must_visit" | "district";
type SuggestionMode = "history" | "search";
type SuggestionHistory = {
  must_visit: string[];
};
type ChoiceField = "budget" | "travel_days";

const HISTORY_STORAGE_KEY = "stree.suggestion-history.v1";
const HISTORY_LIMIT = 6;

const props = defineProps<{
  loading?: boolean;
}>();

const emit = defineEmits<{
  submit: [payload: NavigationFormData];
}>();

const mustVisitDraft = ref("");
const mustVisitTags = ref<string[]>([]);
const districtDraft = ref("");
const districtTags = ref<string[]>([]);
const budgetInput = ref("");
const travelDaysInput = ref("");
const submitAttempted = ref(false);
const activeChoiceField = ref<ChoiceField | null>(null);
const preferenceMode = ref<"balanced" | "time_first" | "richness_first">("balanced");
const activeSuggestionField = ref<SuggestionField | null>(null);
const activeSuggestionMode = ref<SuggestionMode>("history");
const highlightedSuggestionIndex = ref(0);
const preferences = ref<PreferenceInput>({
  mode: "balanced",
  favor_low_budget: false,
  favor_photography: true,
  avoid_crowds: false
});
let closeSuggestionTimer: number | null = null;
const suggestionCatalog = ref(emptySuggestionCatalog());
const suggestionHistory = ref<SuggestionHistory>({
  must_visit: []
});
const HOURS_PER_DAY = 8;

const isLoading = computed(() => Boolean(props.loading));
const hasSelectedTravelDays = computed(() => Boolean(travelDaysInput.value.trim()));
const canSubmit = computed(() => !props.loading);
const travelDaysHint = computed(() => {
  if (hasSelectedTravelDays.value) {
    return "区域只用于补顺路点，不会压过必去景点。";
  }
  return submitAttempted.value ? "请先选择天数后再生成路线。" : "天数为必选项。";
});
const submitLabel = computed(() => {
  if (props.loading) {
    return "生成中";
  }
  if (mustVisitTags.value.length >= 2) {
    return "生成 AI 串联路线";
  }
  if (mustVisitTags.value.length === 1) {
    return "围绕必去点生成";
  }
  if (districtTags.value.length) {
    return "按片区生成";
  }
  if (budgetInput.value.trim() || travelDaysInput.value.trim()) {
    return "按条件生成";
  }
  return "生成路线";
});
const formDigest = computed(() => {
  const parts: string[] = [];

  if (mustVisitTags.value.length) {
    parts.push(`优先考虑 ${mustVisitTags.value.join("、")}`);
  } else if (districtTags.value.length) {
    parts.push(`优先在 ${districtTags.value.join("、")} 一带找线`);
  } else {
    parts.push("先按北京核心区给你出首版路线");
  }

  if (budgetInput.value.trim()) {
    parts.push(`预算 ${budgetInput.value.trim()} 元`);
  }
  if (travelDaysInput.value.trim()) {
    parts.push(`玩 ${travelDaysInput.value.trim()} 天`);
  }
  return parts.join("，");
});
const loadingConditionItems = computed(() => {
  const items: string[] = [];

  if (mustVisitTags.value.length) {
    items.push(`必去 ${mustVisitTags.value.join(" · ")}`);
  }
  if (districtTags.value.length) {
    items.push(`片区 ${districtTags.value.join(" · ")}`);
  }
  if (budgetInput.value.trim()) {
    items.push(`预算 ${budgetInput.value.trim()} 元`);
  }
  if (travelDaysInput.value.trim()) {
    items.push(`行程 ${travelDaysInput.value.trim()} 天`);
  }

  items.push(
    preferenceMode.value === "time_first"
      ? "策略 时间优先"
      : preferenceMode.value === "richness_first"
        ? "策略 丰富度优先"
        : "策略 均衡推进"
  );

  if (preferences.value.favor_low_budget) {
    items.push("倾向 控制预算");
  }
  if (preferences.value.favor_photography) {
    items.push("倾向 拍照友好");
  }
  if (preferences.value.avoid_crowds) {
    items.push("倾向 避开高峰人流");
  }

  return items.length ? items : ["正在提取出发地", "正在整理路线偏好", "正在拼接候选景点"];
});
const loadingTickerItems = computed(() => [...loadingConditionItems.value, ...loadingConditionItems.value]);
const loadingLead = computed(() => {
  if (mustVisitTags.value.length >= 2) {
    return "正在把你选中的点串成一条更顺的路线";
  }
  if (mustVisitTags.value.length === 1) {
    return `正在围绕 ${mustVisitTags.value[0]} 找顺路补点`;
  }
  if (districtTags.value.length) {
    return `正在收拢 ${districtTags.value.join("、")} 一带的候选路线`;
  }
  return "正在把你的条件收拢成一张路线单";
});
const loadingSubline = computed(() => {
  if (formDigest.value.trim()) {
    return formDigest.value;
  }
  return "系统会先整理条件，再生成可以落到地图上的路线解释。";
});
const loadingNodeItems = computed(() => loadingConditionItems.value.slice(0, 4));
const budgetOptions = [
  { value: "", label: "默认" },
  { value: "300", label: "300 元" },
  { value: "600", label: "600 元" },
  { value: "800", label: "800 元" },
  { value: "1000", label: "1000 元" },
  { value: "1500", label: "1500 元" }
] as const;
const travelDayOptions = [
  { value: "", label: "默认" },
  ...Array.from({ length: 30 }, (_, index) => {
    const day = String(index + 1);
    return { value: day, label: `${day} 天` };
  })
];
const selectedTravelDaysLabel = computed(
  () => travelDayOptions.find((option) => option.value === travelDaysInput.value)?.label ?? "默认"
);
const districtMatches = computed(() => {
  const suggestions = suggestionCatalog.value.districtSuggestions.filter((item) => !districtTags.value.includes(item.value));
  return resolveSuggestions("district", districtDraft.value, 8, suggestions);
});
const mustVisitMatches = computed(() => {
  const suggestions = suggestionCatalog.value.mustVisitSuggestions.filter((item) => !mustVisitTags.value.includes(item.value));
  return resolveSuggestions("must_visit", mustVisitDraft.value, 8, suggestions);
});

watch([districtDraft, mustVisitDraft], () => {
  highlightedSuggestionIndex.value = 0;
});

watch([districtMatches, mustVisitMatches], () => {
  const suggestions = getSuggestionsForField(activeSuggestionField.value);
  if (!suggestions.length) {
    highlightedSuggestionIndex.value = 0;
    return;
  }

  if (highlightedSuggestionIndex.value >= suggestions.length) {
    highlightedSuggestionIndex.value = suggestions.length - 1;
  }
});

onBeforeUnmount(() => {
  clearCloseSuggestionTimer();
});

onMounted(async () => {
  loadSuggestionHistory();
  try {
    const catalog = await getPoiSuggestions();
    suggestionCatalog.value = buildSuggestionCatalog(catalog);
  } catch {
    suggestionCatalog.value = emptySuggestionCatalog();
  }
});

function deriveAvailableHoursFromDays(days: number | null): number | null {
  if (days == null) {
    return null;
  }
  return days * HOURS_PER_DAY;
}

function submitForm() {
  if (!hasSelectedTravelDays.value) {
    submitAttempted.value = true;
    activeChoiceField.value = "travel_days";
    return;
  }

  submitAttempted.value = false;
  closeSuggestions();
  commitMustVisitDraft();

  const travelDays = parseOptionalInteger(travelDaysInput.value);
  emit("submit", {
    preferred_districts: districtTags.value,
    must_visit_names: mustVisitTags.value,
    budget: parseOptionalNumber(budgetInput.value),
    travel_days: travelDays,
    available_hours: deriveAvailableHoursFromDays(travelDays),
    preference_mode: preferenceMode.value,
    preferences: {
      ...preferences.value,
      mode: preferenceMode.value
    }
  });
}

function parseOptionalNumber(value: string): number | null {
  const normalized = value.trim().replace(/，/g, ".").replace(/[^\d.]/g, "");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseOptionalInteger(value: string): number | null {
  const parsed = parseOptionalNumber(value);
  return parsed ? Math.round(parsed) : null;
}

function addMustVisitTags(rawValue: string) {
  const values = rawValue
    .split(/[、,，/／\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

  for (const value of values) {
    if (!mustVisitTags.value.includes(value)) {
      mustVisitTags.value.push(value);
    }
    pushSuggestionHistory("must_visit", value);
  }
}

function commitMustVisitDraft() {
  if (!mustVisitDraft.value.trim()) {
    return;
  }
  addMustVisitTags(mustVisitDraft.value);
  mustVisitDraft.value = "";
}

function removeMustVisitTag(index: number) {
  mustVisitTags.value.splice(index, 1);
}

function clearCloseSuggestionTimer() {
  if (closeSuggestionTimer != null) {
    window.clearTimeout(closeSuggestionTimer);
    closeSuggestionTimer = null;
  }
}

function closeSuggestions() {
  clearCloseSuggestionTimer();
  activeSuggestionField.value = null;
  activeSuggestionMode.value = "history";
  activeChoiceField.value = null;
  highlightedSuggestionIndex.value = 0;
}

function openSuggestions(field: SuggestionField, mode: SuggestionMode = "history") {
  clearCloseSuggestionTimer();
  activeSuggestionField.value = field;
  activeSuggestionMode.value = mode;
  highlightedSuggestionIndex.value = 0;
}

function closeSuggestionsSoon() {
  clearCloseSuggestionTimer();
  closeSuggestionTimer = window.setTimeout(() => {
    activeSuggestionField.value = null;
    activeSuggestionMode.value = "history";
    activeChoiceField.value = null;
    highlightedSuggestionIndex.value = 0;
  }, 120);
}

function toggleChoiceMenu(field: ChoiceField) {
  clearCloseSuggestionTimer();
  activeSuggestionField.value = null;
  activeChoiceField.value = activeChoiceField.value === field ? null : field;
}

function openChoiceMenu(field: ChoiceField) {
  clearCloseSuggestionTimer();
  activeSuggestionField.value = null;
  activeChoiceField.value = field;
}

function selectChoice(field: ChoiceField, value: string) {
  if (field === "budget") {
    budgetInput.value = value;
  } else {
    travelDaysInput.value = value;
    if (value) {
      submitAttempted.value = false;
    }
  }
  activeChoiceField.value = null;
}

function closeChoiceMenuSoon() {
  clearCloseSuggestionTimer();
  closeSuggestionTimer = window.setTimeout(() => {
    activeChoiceField.value = null;
  }, 120);
}

function loadSuggestionHistory() {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SuggestionHistory>;
    suggestionHistory.value = {
      must_visit: Array.isArray(parsed.must_visit) ? parsed.must_visit.filter(Boolean).slice(0, HISTORY_LIMIT) : []
    };
  } catch {
    suggestionHistory.value = {
      must_visit: []
    };
  }
}

function persistSuggestionHistory() {
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(suggestionHistory.value));
  } catch {
    // Ignore storage errors so UI interactions stay responsive.
  }
}

function pushSuggestionHistory(field: SuggestionField, rawValue: string) {
  if (field !== "must_visit") {
    return;
  }

  const value = rawValue.trim();
  if (!value) {
    return;
  }

  const current = suggestionHistory.value[field].filter((item) => item !== value);
  suggestionHistory.value = {
    ...suggestionHistory.value,
    [field]: [value, ...current].slice(0, HISTORY_LIMIT)
  };
  persistSuggestionHistory();
}

function getSuggestionPoolForField(field: SuggestionField): PlaceSuggestion[] {
  switch (field) {
    case "must_visit":
      return suggestionCatalog.value.mustVisitSuggestions;
    case "district":
      return suggestionCatalog.value.districtSuggestions;
  }
}

function buildHistorySuggestions(field: SuggestionField, pool: PlaceSuggestion[]): PlaceSuggestion[] {
  if (field !== "must_visit") {
    return pool.slice(0, HISTORY_LIMIT);
  }

  const values = suggestionHistory.value.must_visit.filter((value) => pool.some((item) => item.value === value));
  const historySuggestions = values.map((value) => {
    const matched = pool.find((item) => item.value === value);
    return matched ?? { value, meta: "最近使用" };
  });

  if (historySuggestions.length) {
    return historySuggestions.slice(0, HISTORY_LIMIT);
  }

  return pool.slice(0, HISTORY_LIMIT);
}

function resolveSuggestions(
  field: SuggestionField,
  query: string,
  limit: number,
  poolOverride?: PlaceSuggestion[]
): PlaceSuggestion[] {
  const pool = poolOverride ?? getSuggestionPoolForField(field);
  const normalized = query.trim();

  if (field === "district" && !normalized) {
    return pool.slice(0, limit);
  }

  if (activeSuggestionField.value === field && activeSuggestionMode.value === "history") {
    return buildHistorySuggestions(field, pool);
  }

  if (!normalized) {
    return [];
  }

  return filterPlaceSuggestions(normalized, pool, limit);
}

function getSuggestionsForField(field: SuggestionField | null): PlaceSuggestion[] {
  switch (field) {
    case "must_visit":
      return mustVisitMatches.value;
    case "district":
      return districtMatches.value;
    default:
      return [];
  }
}

function moveHighlightedSuggestion(field: SuggestionField, delta: number) {
  const suggestions = getSuggestionsForField(field);
  if (!suggestions.length) {
    highlightedSuggestionIndex.value = 0;
    return;
  }

  const nextIndex = highlightedSuggestionIndex.value + delta;
  highlightedSuggestionIndex.value = (nextIndex + suggestions.length) % suggestions.length;
}

function selectDistrictSuggestion(value: string) {
  if (!districtTags.value.includes(value)) {
    districtTags.value.push(value);
  }
  districtDraft.value = "";
  closeSuggestions();
}

function removeDistrictTag(index: number) {
  districtTags.value.splice(index, 1);
}

function selectMustVisitSuggestion(value: string) {
  addMustVisitTags(value);
  mustVisitDraft.value = "";
  closeSuggestions();
}

function selectHighlightedSuggestion(field: SuggestionField): boolean {
  const suggestions = getSuggestionsForField(field);
  const selected = suggestions[highlightedSuggestionIndex.value];
  if (!selected) {
    return false;
  }

  if (field === "district") {
    selectDistrictSuggestion(selected.value);
    return true;
  }

  selectMustVisitSuggestion(selected.value);
  return true;
}

function handleSuggestionNavigation(field: SuggestionField, event: KeyboardEvent): boolean {
  const initialMode: SuggestionMode = field === "district" ? "search" : "history";

  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (activeSuggestionField.value !== field) {
      openSuggestions(field, initialMode);
    } else {
      moveHighlightedSuggestion(field, 1);
    }
    return true;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (activeSuggestionField.value !== field) {
      openSuggestions(field, initialMode);
      const suggestions = getSuggestionsForField(field);
      highlightedSuggestionIndex.value = suggestions.length ? suggestions.length - 1 : 0;
    } else {
      moveHighlightedSuggestion(field, -1);
    }
    return true;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeSuggestions();
    return true;
  }

  return false;
}

function handleDistrictKeydown(event: KeyboardEvent) {
  if (handleSuggestionNavigation("district", event)) {
    return;
  }

  if (["Enter", "Tab"].includes(event.key)) {
    if (activeSuggestionField.value === "district" && districtMatches.value.length) {
      if (selectHighlightedSuggestion("district")) {
        event.preventDefault();
      }
      return;
    }
  }

  if (event.key === "Backspace" && !districtDraft.value && districtTags.value.length) {
    districtTags.value.pop();
  }
}

function handleDistrictBlur() {
  districtDraft.value = "";
  closeSuggestionsSoon();
}

function handleMustVisitKeydown(event: KeyboardEvent) {
  if (handleSuggestionNavigation("must_visit", event)) {
    return;
  }

  if (["Enter", "Tab"].includes(event.key)) {
    if (activeSuggestionField.value === "must_visit" && mustVisitMatches.value.length) {
      event.preventDefault();
      selectHighlightedSuggestion("must_visit");
      return;
    }
  }

  if (["Enter", "Tab", ",", "，", "/", "、"].includes(event.key)) {
    event.preventDefault();
    commitMustVisitDraft();
    return;
  }

  if (event.key === "Backspace" && !mustVisitDraft.value && mustVisitTags.value.length) {
    mustVisitTags.value.pop();
  }
}

function handleMustVisitPaste(event: ClipboardEvent) {
  const pastedText = event.clipboardData?.getData("text") ?? "";
  if (!/[、,，/／\n]/.test(pastedText)) {
    return;
  }

  event.preventDefault();
  addMustVisitTags(pastedText);
  mustVisitDraft.value = "";
}

function handleMustVisitBlur() {
  commitMustVisitDraft();
  closeSuggestionsSoon();
}

function suggestionPanelLabel(field: SuggestionField): string {
  if (field === "district") {
    return districtDraft.value.trim() ? "匹配结果" : "区域选项";
  }
  if (activeSuggestionField.value === field && activeSuggestionMode.value === "history") {
    return "最近使用";
  }
  return "匹配结果";
}
</script>

<template>
  <form :class="['topbar panel', { 'topbar-loading': isLoading }]" novalidate @submit.prevent="submitForm">
    <div class="planner-head">
      <div class="planner-head-copy">
        <span class="section-kicker">路线设定</span>
        <strong>{{ isLoading ? "AI 正在串联你的路线条件" : "先把条件收成一张路线单" }}</strong>
        <p>
          {{ isLoading ? "生成中会先提取条件，再压缩成可执行的路线约束与解释。" : "系统会自动用当前位置起步，你只需要告诉我必去景点、偏好区域和现实约束。" }}
        </p>
      </div>
    </div>

    <div v-if="isLoading" class="planner-loading-shell">
      <div class="planner-loading-copy">
        <span class="planner-loading-kicker">条件提取中</span>
        <strong>{{ loadingLead }}</strong>
        <p>{{ loadingSubline }}</p>
      </div>

      <div class="ai-route-loader">
        <div class="route-line-track">
          <div class="route-line-progress"></div>
        </div>
        <div class="route-nodes">
          <span
            v-for="(item, index) in loadingNodeItems"
            :key="`${item}-${index}`"
            class="route-node-chip"
            :style="{ animationDelay: `${index * 300}ms` }"
          >
            <span class="node-dot"></span>
            {{ item }}
          </span>
        </div>
      </div>

      <div class="planner-loading-marquee">
        <div class="planner-loading-track">
          <span
            v-for="(item, index) in loadingTickerItems"
            :key="`${item}-${index}`"
            class="planner-loading-chip"
            :style="{ animationDelay: `${(index % loadingConditionItems.length) * 120}ms` }"
          >
            {{ item }}
          </span>
        </div>
      </div>

      <div class="planner-loading-foot">
        <span class="planner-loading-pulse"></span>
        <small>正在解析条件、筛候选点、生成串联理由与地图方案</small>
      </div>
    </div>

    <div v-else class="planner-compact-shell">
      <div class="planner-compact-grid">
        <label
          :class="[
            'planner-form-group',
            { 'planner-form-open': activeSuggestionField === 'must_visit' }
          ]"
        >
          <span class="planner-form-label">必去点</span>
          <div class="planner-form-control">
            <div class="planner-form-tag-shell" @mousedown="openSuggestions('must_visit')">
              <span v-for="(tag, index) in mustVisitTags" :key="`${tag}-${index}`" class="planner-form-tag">
                {{ tag }}
                <button type="button" class="planner-form-tag-remove" @click="removeMustVisitTag(index)">×</button>
              </span>
              <input
                v-model="mustVisitDraft"
                class="planner-form-tag-input"
                type="text"
                autocomplete="off"
                placeholder="想去哪里"
                @focus="openSuggestions('must_visit', 'history')"
                @input="openSuggestions('must_visit', 'search')"
                @blur="handleMustVisitBlur"
                @keydown="handleMustVisitKeydown"
                @paste="handleMustVisitPaste"
              />
            </div>
            <div v-if="activeSuggestionField === 'must_visit' && mustVisitMatches.length" class="planner-form-menu">
              <span class="planner-form-menu-label">{{ suggestionPanelLabel('must_visit') }}</span>
              <button
                v-for="(item, index) in mustVisitMatches"
                :key="`must-${item.value}`"
                :class="['planner-form-menu-item', { active: highlightedSuggestionIndex === index }]"
                type="button"
                @mouseenter="highlightedSuggestionIndex = index"
                @mousedown.prevent="selectMustVisitSuggestion(item.value)"
              >
                <span class="planner-form-menu-item-value">{{ item.value }}</span>
                <span v-if="item.meta" class="planner-form-menu-item-meta">{{ item.meta }}</span>
              </button>
            </div>
          </div>
        </label>

        <label
          :class="[
            'planner-form-group',
            { 'planner-form-open': activeSuggestionField === 'district' }
          ]"
        >
          <span class="planner-form-label">区域</span>
          <div class="planner-form-control">
            <div class="planner-form-tag-shell" @mousedown="openSuggestions('district', 'search')">
              <span v-for="(tag, index) in districtTags" :key="`${tag}-${index}`" class="planner-form-tag">
                {{ tag }}
                <button type="button" class="planner-form-tag-remove" @click="removeDistrictTag(index)">×</button>
              </span>
              <input
                v-model="districtDraft"
                class="planner-form-tag-input"
                type="text"
                autocomplete="off"
                placeholder="选择区域"
                @focus="openSuggestions('district', 'search')"
                @input="openSuggestions('district', 'search')"
                @blur="handleDistrictBlur"
                @keydown="handleDistrictKeydown"
              />
            </div>
            <div v-if="activeSuggestionField === 'district' && districtMatches.length" class="planner-form-menu">
              <span class="planner-form-menu-label">{{ suggestionPanelLabel('district') }}</span>
              <button
                v-for="(item, index) in districtMatches"
                :key="`district-${item.value}`"
                :class="['planner-form-menu-item', { active: highlightedSuggestionIndex === index }]"
                type="button"
                @mouseenter="highlightedSuggestionIndex = index"
                @mousedown.prevent="selectDistrictSuggestion(item.value)"
              >
                <span class="planner-form-menu-item-value">{{ item.value }}</span>
                <span v-if="item.meta" class="planner-form-menu-item-meta">{{ item.meta }}</span>
              </button>
            </div>
          </div>
        </label>

        <label :class="['planner-form-group', { 'planner-form-open': activeChoiceField === 'budget' }]">
          <span class="planner-form-label">预算</span>
          <div class="planner-form-control">
            <input
              v-model="budgetInput"
              :class="['planner-form-select-input', { active: activeChoiceField === 'budget' }]"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              placeholder="手动输入"
              @focus="openChoiceMenu('budget')"
              @input="openChoiceMenu('budget')"
              @blur="closeChoiceMenuSoon"
            />
            <div v-if="activeChoiceField === 'budget'" class="planner-form-menu">
              <span class="planner-form-menu-label">预算选项</span>
              <button
                v-for="option in budgetOptions"
                :key="`budget-${option.value || 'default'}`"
                :class="['planner-form-menu-item', { active: budgetInput === option.value }]"
                type="button"
                @mousedown.prevent="selectChoice('budget', option.value)"
              >
                <span class="planner-form-menu-item-value">{{ option.label }}</span>
              </button>
            </div>
          </div>
        </label>

        <label :class="['planner-form-group', { 'planner-form-open': activeChoiceField === 'travel_days' }]">
          <span class="planner-form-label">天数</span>
          <div class="planner-form-control">
            <button
              type="button"
              :class="['planner-form-select-trigger', { active: activeChoiceField === 'travel_days' }]"
              @click="toggleChoiceMenu('travel_days')"
              @blur="closeChoiceMenuSoon"
            >
              <span>{{ selectedTravelDaysLabel }}</span>
              <span class="planner-form-caret"></span>
            </button>
            <div v-if="activeChoiceField === 'travel_days'" class="planner-form-menu">
              <span class="planner-form-menu-label">时长选项</span>
              <button
                v-for="option in travelDayOptions"
                :key="`travel-${option.value || 'default'}`"
                :class="['planner-form-menu-item', { active: travelDaysInput === option.value }]"
                type="button"
                @mousedown.prevent="selectChoice('travel_days', option.value)"
              >
                <span class="planner-form-menu-item-value">{{ option.label }}</span>
              </button>
            </div>
          </div>
        </label>
      </div>

      <div class="planner-compact-toolbar">
        <div class="planner-compact-control">
          <span class="planner-control-label">路线偏好</span>
          <div class="mode-switch planner-pill-row">
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
        </div>

        <div class="planner-compact-control">
          <span class="planner-control-label">附加倾向</span>
          <div class="toggle-row planner-pill-row">
            <label class="toggle-item">
              <input v-model="preferences.favor_low_budget" type="checkbox" />
              <span>尽量省钱</span>
            </label>
            <label class="toggle-item">
              <input v-model="preferences.favor_photography" type="checkbox" />
              <span>拍照友好</span>
            </label>
            <label class="toggle-item">
              <input v-model="preferences.avoid_crowds" type="checkbox" />
              <span>尽量避开人多</span>
            </label>
          </div>
        </div>
      </div>

      <div class="planner-compact-foot">
        <div class="planner-compact-meta">
          <small :class="['field-hint', { 'field-hint-error': !hasSelectedTravelDays && submitAttempted }]">
            {{ travelDaysHint }}
          </small>
          <p class="planner-submit-digest">{{ formDigest }}</p>
        </div>
        <button class="primary planner-submit-button" type="submit" :disabled="!canSubmit">
          <AppIcon name="spark" />
          {{ submitLabel }}
        </button>
      </div>
    </div>
  </form>
</template>

<style scoped>
.topbar-loading {
  gap: 12px;
  padding: 16px 18px;
}

.planner-loading-shell {
  position: relative;
  display: grid;
  gap: 12px;
  padding: 20px;
  border-radius: 16px;
  overflow: hidden;
  background: linear-gradient(145deg, #f8fbff, #eef6fb);
  border: 1px solid rgba(69, 136, 203, 0.15);
}

.planner-loading-shell::after {
  content: "";
  position: absolute;
  inset: 0;
  background:
    linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
  transform: translateX(-100%);
  animation: plannerLoadingSweep 2.8s linear infinite;
  pointer-events: none;
}

.planner-loading-copy {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 4px;
}

.planner-loading-kicker {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  min-height: 24px;
  padding: 0 9px;
  border-radius: 999px;
  background: rgba(34, 77, 114, 0.08);
  color: var(--accent);
  font-size: 0.73rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.planner-loading-copy strong {
  font-family: var(--display-font);
  font-size: 1.18rem;
  line-height: 1.02;
  color: #18364f;
}

.planner-loading-copy p {
  margin: 0;
  color: #5d7081;
  font-size: 0.88rem;
  line-height: 1.45;
}

.ai-route-loader {
  position: relative;
  margin: 16px 0 6px;
  padding: 0 10px;
}

.route-line-track {
  position: absolute;
  top: 12px;
  left: 0;
  right: 0;
  height: 2px;
  background: repeating-linear-gradient(90deg, #d3e2ef 0, #d3e2ef 4px, transparent 4px, transparent 8px);
  z-index: 1;
}

.route-line-progress {
  position: absolute;
  top: -1px;
  left: 0;
  height: 4px;
  width: 30%;
  background: linear-gradient(90deg, transparent, #4588cb, #8bc2f5);
  border-radius: 4px;
  filter: drop-shadow(0 0 4px rgba(69, 136, 203, 0.6));
  animation: scanRoute 2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

.route-nodes {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  position: relative;
  z-index: 2;
}

.route-node-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  max-width: 148px;
  font-size: 0.75rem;
  line-height: 1.25;
  color: #5d7081;
  font-weight: 500;
  text-align: center;
  opacity: 0.5;
  transform: translateY(4px);
  animation: nodeActivate 2.5s ease-in-out infinite;
}

.node-dot {
  width: 10px;
  height: 10px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #a4b9cb;
  animation: dotPulse 2.5s ease-in-out infinite;
}

.planner-loading-marquee {
  position: relative;
  z-index: 1;
  overflow: hidden;
  mask-image: linear-gradient(90deg, transparent, rgba(0, 0, 0, 1) 10%, rgba(0, 0, 0, 1) 90%, transparent);
  padding-bottom: 2px;
}

.planner-loading-track {
  display: flex;
  align-items: center;
  gap: 10px;
  width: max-content;
  padding: 0 12px;
  animation: plannerTickerMove 20s linear infinite;
}

.planner-loading-chip {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 0 11px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid rgba(34, 77, 114, 0.1);
  color: #32516c;
  white-space: nowrap;
  font-size: 0.8rem;
  box-shadow: 0 10px 20px rgba(52, 77, 103, 0.06);
  animation: plannerChipWave 1.8s ease-in-out infinite;
}

.planner-loading-foot {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: #607485;
}

.planner-loading-foot small {
  font-size: 0.84rem;
  line-height: 1.4;
}

.planner-loading-pulse {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: linear-gradient(135deg, #4588cb, #295985);
  box-shadow: 0 0 0 rgba(69, 136, 203, 0.35);
  animation: plannerPulse 1.6s ease-out infinite;
}

.field-hint {
  color: #66756f;
  line-height: 1.45;
  font-size: 0.82rem;
}

.field-hint-error {
  color: #b14b32;
  font-weight: 600;
}

.planner-compact-shell {
  --planner-field-height: 46px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-radius: 16px;
  background: #fcfdfd;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.03), inset 0 0 0 1px rgba(62, 91, 116, 0.08);
  overflow: visible;
  isolation: isolate;
}

.planner-compact-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(220px, 1fr));
  gap: 14px;
  align-items: start;
  overflow: visible;
  position: relative;
  z-index: 3;
}

.planner-compact-span-2 {
  grid-column: span 2;
  min-width: 0;
}

.planner-form-group {
  display: grid;
  gap: 6px;
  width: 100%;
  min-width: 0;
  align-content: start;
  padding: 10px;
  border-radius: 16px;
}

.planner-form-label {
  min-width: 0;
  padding-left: 2px;
  color: #58718a;
  font-size: 0.76rem;
  line-height: 1.2;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}

.planner-form-control {
  position: relative;
  display: flex;
  align-items: stretch;
  width: 100%;
  min-width: 0;
  min-height: var(--planner-field-height);
}

.planner-form-tag-shell,
.planner-form-select-input,
.planner-form-select-trigger {
  width: 100%;
  min-width: 0;
  min-height: var(--planner-field-height);
  border: 1px solid transparent;
  border-radius: 10px;
  background: rgba(240, 244, 248, 0.6);
  transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
  color: #20323f;
  font-size: 0.94rem;
}

.planner-form-tag-shell {
  display: flex;
  flex-wrap: wrap;
  align-content: center;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
}

.planner-form-select-input,
.planner-form-select-trigger {
  height: var(--planner-field-height);
  padding: 0 12px;
  line-height: 1.2;
}

.planner-form-select-input {
  outline: none;
}

.planner-form-select-input::placeholder {
  color: #6f8190;
}

.planner-form-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  text-align: left;
  box-shadow: none;
}

.planner-form-select-trigger span:first-child {
  display: inline-flex;
  align-items: center;
  min-height: 100%;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.planner-form-tag-shell:focus-within,
.planner-form-select-input:focus,
.planner-form-select-input.active,
.planner-form-select-trigger.active,
.planner-form-select-trigger:focus-visible {
  background: #fff;
  border-color: #4588cb;
  box-shadow: 0 0 0 3px rgba(69, 136, 203, 0.1);
  outline: none;
}

.planner-form-tag-input {
  flex: 1 1 120px;
  min-width: 120px;
  height: 30px;
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  color: #20323f;
  font-size: 0.94rem;
  line-height: 30px;
  outline: none;
}

.planner-form-tag-input:focus {
  border-color: transparent;
  box-shadow: none;
}

.planner-form-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 0 9px;
  border-radius: 999px;
  background: rgba(34, 77, 114, 0.1);
  color: var(--accent-strong);
  font-size: 0.84rem;
  font-weight: 600;
}

.planner-form-tag-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: rgba(34, 77, 114, 0.1);
  color: inherit;
  cursor: pointer;
}

.planner-form-tag-remove:hover,
.planner-form-select-trigger:hover {
  transform: none;
}

.planner-form-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 40;
  display: grid;
  gap: 4px;
  width: 100%;
  min-width: 100%;
  max-height: 280px;
  padding: 6px;
  overflow-y: auto;
  border-radius: 14px;
  border: 1px solid rgba(116, 149, 178, 0.14);
  background: rgba(250, 253, 255, 0.96);
  box-shadow: 0 18px 36px rgba(55, 81, 107, 0.14);
}

.planner-form-menu-label {
  padding: 4px 8px 6px;
  color: #70807a;
  font-size: 0.74rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.planner-form-menu-item {
  display: grid;
  gap: 2px;
  width: 100%;
  min-height: 38px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: #30423b;
  text-align: left;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
}

.planner-form-menu-item:hover,
.planner-form-menu-item.active {
  border-color: rgba(21, 71, 63, 0.12);
  background: rgba(21, 71, 63, 0.06);
}

.planner-form-menu-item-value {
  line-height: 1.25;
  white-space: nowrap;
}

.planner-form-menu-item-meta {
  color: #6f7f78;
  font-size: 0.8rem;
  line-height: 1.2;
}

.planner-control-label {
  color: #58718a;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.planner-pill-row {
  align-items: center;
}

.planner-compact-toolbar {
  display: grid;
  gap: 12px;
  padding: 12px 14px;
  background: rgba(69, 136, 203, 0.04);
  border-radius: 10px;
  position: relative;
  z-index: 1;
}

.planner-compact-control {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.planner-compact-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  position: relative;
  z-index: 1;
}

.planner-compact-meta {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.planner-submit-digest {
  margin: 0;
  color: #66756f;
  font-size: 0.84rem;
  line-height: 1.4;
}

.planner-submit-button {
  min-width: 186px;
  flex-shrink: 0;
}

.planner-compact-shell :deep(.mode-chip),
.planner-compact-shell :deep(.toggle-item) {
  height: 32px;
  padding: 0 10px;
  font-size: 0.8rem;
}

.planner-form-caret {
  width: 9px;
  height: 9px;
  flex-shrink: 0;
  border-right: 1.7px solid currentColor;
  border-bottom: 1.7px solid currentColor;
  transform: rotate(45deg) translateY(-1px);
  opacity: 0.8;
}

.planner-form-open,
.planner-form-open:focus-within {
  z-index: 30;
}

@media (max-width: 760px) {
  .planner-compact-grid {
    grid-template-columns: 1fr;
  }

  .planner-loading-shell {
    padding: 12px;
  }

  .planner-loading-copy strong {
    font-size: 1.1rem;
  }

  .route-nodes {
    gap: 6px;
  }

  .route-node-chip {
    max-width: 96px;
    font-size: 0.68rem;
  }

  .planner-compact-toolbar {
    flex-direction: column;
    align-items: flex-start;
  }

  .planner-compact-foot {
    flex-direction: column;
    align-items: stretch;
  }

  .planner-submit-button {
    width: 100%;
  }
}

@media (max-width: 980px) {
  .planner-compact-grid {
    grid-template-columns: 1fr;
  }
}

@keyframes plannerTickerMove {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}

@keyframes plannerChipWave {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-6px);
  }
}

@keyframes plannerPulse {
  0% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(69, 136, 203, 0.34);
  }
  70% {
    transform: scale(1);
    box-shadow: 0 0 0 9px rgba(69, 136, 203, 0);
  }
  100% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(69, 136, 203, 0);
  }
}

@keyframes plannerLoadingSweep {
  0% {
    transform: translateX(-120%);
  }
  100% {
    transform: translateX(120%);
  }
}

@keyframes scanRoute {
  0% {
    left: -30%;
    opacity: 0;
  }
  10% {
    opacity: 1;
  }
  90% {
    opacity: 1;
  }
  100% {
    left: 100%;
    opacity: 0;
  }
}

@keyframes nodeActivate {
  0%,
  100% {
    opacity: 0.5;
    transform: translateY(4px) scale(0.95);
    color: #5d7081;
  }
  15%,
  40% {
    opacity: 1;
    transform: translateY(0) scale(1.05);
    color: #18364f;
  }
}

@keyframes dotPulse {
  0%,
  100% {
    border-color: #a4b9cb;
    box-shadow: none;
    background: #fff;
  }
  15%,
  40% {
    border-color: #4588cb;
    background: #4588cb;
    box-shadow: 0 0 0 4px rgba(69, 136, 203, 0.2);
  }
}
</style>

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
import type { LocationPoint, NavigationFormData, PreferenceInput } from "../types";

type SuggestionField = "origin" | "must_visit" | "destination" | "district";
type SuggestionMode = "history" | "search";
type SuggestionHistory = Record<SuggestionField, string[]>;

const HISTORY_STORAGE_KEY = "stree.suggestion-history.v1";
const HISTORY_LIMIT = 6;

const props = defineProps<{
  loading?: boolean;
  initialOrigin?: LocationPoint;
}>();

const emit = defineEmits<{
  submit: [payload: NavigationFormData];
  locateOrigin: [];
}>();

const originInput = ref("我的位置");
const mustVisitDraft = ref("");
const mustVisitTags = ref<string[]>([]);
const destinationInput = ref("");
const districtInput = ref("");
const budgetInput = ref("");
const availableHoursInput = ref("");
const maxPoiCountInput = ref("");
const showAdvanced = ref(false);
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
  origin: [],
  must_visit: [],
  destination: [],
  district: []
});

const canSubmit = computed(() => !props.loading);
const submitLabel = computed(() => {
  if (props.loading) {
    return "生成中";
  }
  if (mustVisitTags.value.length >= 2) {
    return "生成串联路线";
  }
  if (mustVisitTags.value.length === 1) {
    return "围绕必去点规划";
  }
  if (destinationInput.value.trim()) {
    return "围绕目的地生成";
  }
  if (districtInput.value.trim()) {
    return "按片区生成";
  }
  if (budgetInput.value.trim() || availableHoursInput.value.trim()) {
    return "按条件智能规划";
  }
  return "智能规划";
});
const originMatches = computed(() => resolveSuggestions("origin", originInput.value, 8));
const destinationMatches = computed(() => resolveSuggestions("destination", destinationInput.value, 8));
const districtMatches = computed(() => resolveSuggestions("district", districtInput.value, 6));
const mustVisitMatches = computed(() => {
  const suggestions = suggestionCatalog.value.mustVisitSuggestions.filter((item) => !mustVisitTags.value.includes(item.value));
  return resolveSuggestions("must_visit", mustVisitDraft.value, 8, suggestions);
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

watch([originInput, destinationInput, districtInput, mustVisitDraft], () => {
  highlightedSuggestionIndex.value = 0;
});

watch([originMatches, destinationMatches, districtMatches, mustVisitMatches], () => {
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

function submitForm() {
  commitMustVisitDraft();
  persistFreeTextSelections();

  emit("submit", {
    origin_query: originInput.value.trim() || "我的位置",
    destination_query: destinationInput.value.trim(),
    district_query: districtInput.value.trim(),
    must_visit_names: mustVisitTags.value,
    budget: parseOptionalNumber(budgetInput.value),
    available_hours: parseOptionalNumber(availableHoursInput.value),
    preference_mode: preferenceMode.value,
    preferences: {
      ...preferences.value,
      mode: preferenceMode.value
    },
    max_poi_count: parseOptionalInteger(maxPoiCountInput.value)
  });
}

function parseOptionalNumber(value: string): number | null {
  const normalized = value.trim();
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
    highlightedSuggestionIndex.value = 0;
  }, 120);
}

function loadSuggestionHistory() {
  const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SuggestionHistory>;
    suggestionHistory.value = {
      origin: Array.isArray(parsed.origin) ? parsed.origin.filter(Boolean).slice(0, HISTORY_LIMIT) : [],
      must_visit: Array.isArray(parsed.must_visit) ? parsed.must_visit.filter(Boolean).slice(0, HISTORY_LIMIT) : [],
      destination: Array.isArray(parsed.destination) ? parsed.destination.filter(Boolean).slice(0, HISTORY_LIMIT) : [],
      district: Array.isArray(parsed.district) ? parsed.district.filter(Boolean).slice(0, HISTORY_LIMIT) : []
    };
  } catch {
    suggestionHistory.value = {
      origin: [],
      must_visit: [],
      destination: [],
      district: []
    };
  }
}

function persistSuggestionHistory() {
  window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(suggestionHistory.value));
}

function pushSuggestionHistory(field: SuggestionField, rawValue: string) {
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
    case "origin":
      return suggestionCatalog.value.originSuggestions;
    case "must_visit":
      return suggestionCatalog.value.mustVisitSuggestions;
    case "destination":
      return suggestionCatalog.value.destinationSuggestions;
    case "district":
      return suggestionCatalog.value.districtSuggestions;
  }
}

function buildHistorySuggestions(field: SuggestionField, pool: PlaceSuggestion[]): PlaceSuggestion[] {
  const values =
    field === "must_visit"
      ? suggestionHistory.value[field].filter((value) => pool.some((item) => item.value === value))
      : suggestionHistory.value[field];
  const historySuggestions = values.map((value) => {
    const matched = pool.find((item) => item.value === value);
    return matched ?? { value, meta: "最近使用" };
  });

  if (field === "origin" && !historySuggestions.some((item) => item.value === "我的位置")) {
    historySuggestions.unshift({ value: "我的位置", keywords: ["当前位置"], meta: "当前位置" });
  }

  return historySuggestions.slice(0, HISTORY_LIMIT);
}

function resolveSuggestions(
  field: SuggestionField,
  query: string,
  limit: number,
  poolOverride?: PlaceSuggestion[]
): PlaceSuggestion[] {
  const pool = poolOverride ?? getSuggestionPoolForField(field);
  const normalized = query.trim();

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
    case "origin":
      return originMatches.value;
    case "must_visit":
      return mustVisitMatches.value;
    case "destination":
      return destinationMatches.value;
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

function selectOriginSuggestion(value: string) {
  originInput.value = value;
  pushSuggestionHistory("origin", value);
  closeSuggestions();
}

function selectDestinationSuggestion(value: string) {
  destinationInput.value = value;
  pushSuggestionHistory("destination", value);
  closeSuggestions();
}

function selectDistrictSuggestion(value: string) {
  districtInput.value = value;
  pushSuggestionHistory("district", value);
  closeSuggestions();
}

function selectMustVisitSuggestion(value: string) {
  addMustVisitTags(value);
  mustVisitDraft.value = "";
  openSuggestions("must_visit");
}

function selectHighlightedSuggestion(field: SuggestionField): boolean {
  const suggestions = getSuggestionsForField(field);
  const selected = suggestions[highlightedSuggestionIndex.value];
  if (!selected) {
    return false;
  }

  if (field === "origin") {
    selectOriginSuggestion(selected.value);
    return true;
  }

  if (field === "destination") {
    selectDestinationSuggestion(selected.value);
    return true;
  }

  if (field === "district") {
    selectDistrictSuggestion(selected.value);
    return true;
  }

  selectMustVisitSuggestion(selected.value);
  return true;
}

function handleSuggestionNavigation(field: SuggestionField, event: KeyboardEvent): boolean {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (activeSuggestionField.value !== field) {
      openSuggestions(field, "history");
    } else {
      moveHighlightedSuggestion(field, 1);
    }
    return true;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (activeSuggestionField.value !== field) {
      openSuggestions(field, "history");
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

function handleOriginKeydown(event: KeyboardEvent) {
  if (handleSuggestionNavigation("origin", event)) {
    return;
  }

  if (event.key === "Enter" && activeSuggestionField.value === "origin") {
    if (selectHighlightedSuggestion("origin")) {
      event.preventDefault();
    }
  }
}

function handleDestinationKeydown(event: KeyboardEvent) {
  if (handleSuggestionNavigation("destination", event)) {
    return;
  }

  if (event.key === "Enter" && activeSuggestionField.value === "destination") {
    if (selectHighlightedSuggestion("destination")) {
      event.preventDefault();
    }
  }
}

function handleDistrictKeydown(event: KeyboardEvent) {
  if (handleSuggestionNavigation("district", event)) {
    return;
  }

  if (event.key === "Enter" && activeSuggestionField.value === "district") {
    if (selectHighlightedSuggestion("district")) {
      event.preventDefault();
    }
  }
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

function persistFreeTextSelections() {
  if (originInput.value.trim() && originInput.value.trim() !== "我的位置") {
    pushSuggestionHistory("origin", originInput.value);
  }
  if (destinationInput.value.trim()) {
    pushSuggestionHistory("destination", destinationInput.value);
  }
  if (districtInput.value.trim()) {
    pushSuggestionHistory("district", districtInput.value);
  }
}

function suggestionPanelLabel(field: SuggestionField): string {
  if (activeSuggestionField.value === field && activeSuggestionMode.value === "history") {
    return "最近使用";
  }
  return "匹配结果";
}
</script>

<template>
  <section class="topbar panel">
    <div class="planner-head">
      <div class="planner-head-copy">
        <span class="section-kicker">路线设定</span>
        <strong>把已知条件填进来</strong>
        <p>起点、必去点、具体目的地和偏好片区分开填，系统再补顺路点。</p>
      </div>
    </div>

    <div class="topbar-row planner-grid">
      <label class="field-group">
        <span class="field-label">出发地</span>
        <div class="field-control">
          <input
            v-model="originInput"
            type="text"
            autocomplete="off"
            placeholder="我的位置 / 景点 / 商圈"
            @focus="openSuggestions('origin', 'history')"
            @input="openSuggestions('origin', 'search')"
            @blur="closeSuggestionsSoon"
            @keydown="handleOriginKeydown"
          />
          <div v-if="activeSuggestionField === 'origin' && originMatches.length" class="input-suggestions">
            <span class="input-suggestions-label">{{ suggestionPanelLabel('origin') }}</span>
            <button
              v-for="(item, index) in originMatches"
              :key="`origin-${item.value}`"
              :class="['input-suggestion', { active: highlightedSuggestionIndex === index }]"
              type="button"
              @mouseenter="highlightedSuggestionIndex = index"
              @mousedown.prevent="selectOriginSuggestion(item.value)"
            >
              <span class="input-suggestion-value">{{ item.value }}</span>
              <span v-if="item.meta" class="input-suggestion-meta">{{ item.meta }}</span>
            </button>
          </div>
        </div>
      </label>

      <label class="field-group">
        <span class="field-label">必去景点</span>
        <div class="field-control">
          <div class="tag-input-shell" @mousedown="openSuggestions('must_visit')">
            <span v-for="(tag, index) in mustVisitTags" :key="`${tag}-${index}`" class="must-visit-tag">
              {{ tag }}
              <button type="button" class="tag-remove" @click="removeMustVisitTag(index)">×</button>
            </span>
            <input
              v-model="mustVisitDraft"
              class="tag-input"
              type="text"
              autocomplete="off"
              placeholder="输入后回车，优先选中候选项"
              @focus="openSuggestions('must_visit', 'history')"
              @input="openSuggestions('must_visit', 'search')"
              @blur="handleMustVisitBlur"
              @keydown="handleMustVisitKeydown"
              @paste="handleMustVisitPaste"
            />
          </div>
          <div v-if="activeSuggestionField === 'must_visit' && mustVisitMatches.length" class="input-suggestions">
            <span class="input-suggestions-label">{{ suggestionPanelLabel('must_visit') }}</span>
            <button
              v-for="(item, index) in mustVisitMatches"
              :key="`must-${item.value}`"
              :class="['input-suggestion', { active: highlightedSuggestionIndex === index }]"
              type="button"
              @mouseenter="highlightedSuggestionIndex = index"
              @mousedown.prevent="selectMustVisitSuggestion(item.value)"
            >
              <span class="input-suggestion-value">{{ item.value }}</span>
              <span v-if="item.meta" class="input-suggestion-meta">{{ item.meta }}</span>
            </button>
          </div>
        </div>
      </label>

      <label class="field-group">
        <span class="field-label">具体目的地</span>
        <div class="field-control">
          <input
            v-model="destinationInput"
            type="text"
            autocomplete="off"
            placeholder="例如 故宫、什刹海、国贸"
            @focus="openSuggestions('destination', 'history')"
            @input="openSuggestions('destination', 'search')"
            @blur="closeSuggestionsSoon"
            @keydown="handleDestinationKeydown"
          />
          <div v-if="activeSuggestionField === 'destination' && destinationMatches.length" class="input-suggestions">
            <span class="input-suggestions-label">{{ suggestionPanelLabel('destination') }}</span>
            <button
              v-for="(item, index) in destinationMatches"
              :key="`destination-${item.value}`"
              :class="['input-suggestion', { active: highlightedSuggestionIndex === index }]"
              type="button"
              @mouseenter="highlightedSuggestionIndex = index"
              @mousedown.prevent="selectDestinationSuggestion(item.value)"
            >
              <span class="input-suggestion-value">{{ item.value }}</span>
              <span v-if="item.meta" class="input-suggestion-meta">{{ item.meta }}</span>
            </button>
          </div>
        </div>
      </label>

      <label class="field-group">
        <span class="field-label">偏好片区</span>
        <div class="field-control">
          <input
            v-model="districtInput"
            type="text"
            autocomplete="off"
            placeholder="例如 东城区、海淀区"
            @focus="openSuggestions('district', 'history')"
            @input="openSuggestions('district', 'search')"
            @blur="closeSuggestionsSoon"
            @keydown="handleDistrictKeydown"
          />
          <div v-if="activeSuggestionField === 'district' && districtMatches.length" class="input-suggestions">
            <span class="input-suggestions-label">{{ suggestionPanelLabel('district') }}</span>
            <button
              v-for="(item, index) in districtMatches"
              :key="`district-${item.value}`"
              :class="['input-suggestion', { active: highlightedSuggestionIndex === index }]"
              type="button"
              @mouseenter="highlightedSuggestionIndex = index"
              @mousedown.prevent="selectDistrictSuggestion(item.value)"
            >
              <span class="input-suggestion-value">{{ item.value }}</span>
              <span v-if="item.meta" class="input-suggestion-meta">{{ item.meta }}</span>
            </button>
          </div>
        </div>
      </label>

      <div class="topbar-actions">
        <button class="secondary-button" type="button" @click="emit('locateOrigin')">
          <AppIcon name="pin" />
          当前位置
        </button>

        <button class="secondary-button" type="button" @click="showAdvanced = !showAdvanced">
          <AppIcon name="briefcase" />
          {{ showAdvanced ? "收起偏好" : "预算 / 时长 / 偏好" }}
        </button>

        <button class="primary" type="button" :disabled="!canSubmit" @click="submitForm">
          <AppIcon name="spark" />
          {{ submitLabel }}
        </button>
      </div>
    </div>

    <div v-if="showAdvanced" class="advanced-panel">
      <div class="topbar-row advanced-row">
        <label class="field-group field-group-compact">
          <span class="field-label">预算（可选）</span>
          <input v-model="budgetInput" type="number" min="100" step="50" placeholder="留空则智能默认" />
        </label>

        <label class="field-group field-group-compact">
          <span class="field-label">可玩时长（可选）</span>
          <input v-model="availableHoursInput" type="number" min="2" max="18" placeholder="留空则按一日游默认" />
        </label>

        <label class="field-group field-group-compact">
          <span class="field-label">希望串几个点（可选）</span>
          <input v-model="maxPoiCountInput" type="number" min="1" max="5" placeholder="留空则智能默认" />
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

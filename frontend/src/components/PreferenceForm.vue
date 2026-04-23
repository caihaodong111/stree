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
type SuggestionHistory = Record<SuggestionField, string[]>;

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
const districtInput = ref("");
const budgetInput = ref("");
const travelDaysInput = ref("");
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
  must_visit: [],
  district: []
});
const HOURS_PER_DAY = 8;

const canSubmit = computed(() => !props.loading);
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
  if (districtInput.value.trim()) {
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
  } else if (districtInput.value.trim()) {
    parts.push(`优先在 ${districtInput.value.trim()} 一带找线`);
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
const districtMatches = computed(() => resolveSuggestions("district", districtInput.value, 6));
const mustVisitMatches = computed(() => {
  const suggestions = suggestionCatalog.value.mustVisitSuggestions.filter((item) => !mustVisitTags.value.includes(item.value));
  return resolveSuggestions("must_visit", mustVisitDraft.value, 8, suggestions);
});

watch([districtInput, mustVisitDraft], () => {
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
  closeSuggestions();
  commitMustVisitDraft();
  try {
    persistFreeTextSelections();
  } catch {
    // Do not block route generation when local history persistence fails.
  }

  const travelDays = parseOptionalInteger(travelDaysInput.value);
  emit("submit", {
    district_query: districtInput.value.trim(),
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
      must_visit: Array.isArray(parsed.must_visit) ? parsed.must_visit.filter(Boolean).slice(0, HISTORY_LIMIT) : [],
      district: Array.isArray(parsed.district) ? parsed.district.filter(Boolean).slice(0, HISTORY_LIMIT) : []
    };
  } catch {
    suggestionHistory.value = {
      must_visit: [],
      district: []
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
  const values =
    field === "must_visit"
      ? suggestionHistory.value[field].filter((value) => pool.some((item) => item.value === value))
      : suggestionHistory.value[field];
  const historySuggestions = values.map((value) => {
    const matched = pool.find((item) => item.value === value);
    return matched ?? { value, meta: "最近使用" };
  });

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
  districtInput.value = value;
  pushSuggestionHistory("district", value);
  closeSuggestions();
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
  <form class="topbar panel" novalidate @submit.prevent="submitForm">
    <div class="planner-head">
      <div class="planner-head-copy">
        <span class="section-kicker">路线设定</span>
        <strong>先把条件收成一张路线单</strong>
        <p>系统会自动用当前位置起步，你只需要告诉我必去景点、偏好区域和现实约束。</p>
      </div>
    </div>

    <div class="planner-layout">
      <section class="planner-section planner-section-primary">
        <div class="planner-section-head">
          <span>景点与区域</span>
          <small>先锁定必去景点，再给一个大致片区。</small>
        </div>

        <div class="planner-primary-grid">
          <label class="field-group field-group-featured">
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
                  placeholder="输入后回车，可填多个"
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

          <label class="field-group field-group-secondary">
            <span class="field-label">偏好区域</span>
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
        </div>

        <small class="field-hint field-hint-inline">区域只用于补顺路点，不会压过必去景点。</small>
      </section>

      <div class="planner-side-stack">
        <section class="planner-section planner-control-panel">
          <div class="planner-section-head">
            <span>现实约束与偏好</span>
            <small>用更少的条件，把路线收得更贴近现实。</small>
          </div>

          <div class="planner-inline-grid planner-inline-grid-tight">
            <label class="field-group field-group-compact">
              <span class="field-label">预算（可选）</span>
              <select v-model="budgetInput">
                <option value="">智能默认</option>
                <option value="300">300 元</option>
                <option value="600">600 元</option>
                <option value="800">800 元</option>
                <option value="1000">1000 元</option>
                <option value="1500">1500 元</option>
              </select>
            </label>

            <label class="field-group field-group-compact">
              <span class="field-label">可玩天数（可选）</span>
              <select v-model="travelDaysInput">
                <option value="">智能默认</option>
                <option value="1">1 天</option>
                <option value="2">2 天</option>
                <option value="3">3 天</option>
              </select>
            </label>
          </div>

          <div class="planner-control-block">
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

          <div class="planner-control-block">
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

          <div class="planner-submit-row">
            <p class="planner-submit-digest">{{ formDigest }}</p>
            <button class="primary planner-submit-button" type="submit" :disabled="!canSubmit">
              <AppIcon name="spark" />
              {{ submitLabel }}
            </button>
          </div>
        </section>
      </div>
    </div>
  </form>
</template>

<style scoped>
.planner-layout {
  display: grid;
  gap: 14px;
  grid-template-columns: minmax(0, 1.34fr) minmax(320px, 0.9fr);
}

.planner-section {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 22px;
  border: 1px solid rgba(20, 33, 29, 0.06);
  background: linear-gradient(180deg, rgba(255, 253, 249, 0.96), rgba(246, 240, 231, 0.86));
}

.planner-section-primary {
  min-height: 100%;
}

.planner-section-compact {
  gap: 10px;
}

.planner-side-stack {
  display: grid;
  gap: 14px;
  align-content: start;
}

.planner-section-head {
  display: grid;
  gap: 4px;
}

.planner-section-head span {
  font-size: 0.82rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #23453c;
}

.planner-section-head small,
.field-hint {
  color: #66756f;
  line-height: 1.5;
}

.field-hint {
  font-size: 0.82rem;
}

.field-hint-inline {
  margin-top: 0;
}

.planner-primary-grid {
  display: grid;
  gap: 8px;
  grid-template-columns: minmax(0, 1.35fr) minmax(220px, 0.7fr);
  align-items: start;
}

.field-group-featured,
.field-group-secondary {
  gap: 6px;
  padding: 10px;
}

.planner-inline-grid {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.planner-inline-grid-tight {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.planner-control-panel {
  gap: 12px;
}

.planner-control-block {
  display: grid;
  gap: 8px;
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

.planner-submit-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 2px;
  border-top: 1px solid rgba(20, 33, 29, 0.08);
}

.planner-submit-digest {
  margin: 0;
  color: #66756f;
  font-size: 0.84rem;
  line-height: 1.4;
}

.planner-submit-button {
  min-width: 200px;
  flex-shrink: 0;
}

.planner-section :deep(input),
.planner-section :deep(select) {
  height: 46px;
  padding: 0 14px;
  border-radius: 15px;
}

.planner-section :deep(.tag-input-shell) {
  min-height: 46px;
  padding: 6px 10px;
  border-radius: 15px;
}

.planner-section :deep(.must-visit-tag) {
  min-height: 28px;
  font-size: 0.88rem;
}

.planner-section :deep(.mode-chip),
.planner-section :deep(.toggle-item) {
  height: 36px;
}

@media (max-width: 760px) {
  .planner-layout,
  .planner-primary-grid,
  .planner-inline-grid,
  .planner-inline-grid-tight {
    grid-template-columns: 1fr;
  }

  .planner-submit-row {
    flex-direction: column;
    align-items: stretch;
  }

  .planner-submit-button {
    width: 100%;
  }
}
</style>

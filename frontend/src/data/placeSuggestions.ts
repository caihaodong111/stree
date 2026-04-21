import type { PlaceSuggestion, POISuggestionCatalogResponse, POISuggestionItem } from "../types";

export type { PlaceSuggestion } from "../types";

interface PlaceSuggestionCatalog {
  originSuggestions: PlaceSuggestion[];
  mustVisitSuggestions: PlaceSuggestion[];
  destinationSuggestions: PlaceSuggestion[];
  districtSuggestions: PlaceSuggestion[];
}

const CURRENT_LOCATION_SUGGESTION: PlaceSuggestion = {
  value: "我的位置",
  keywords: ["当前位置"],
  meta: "当前位置"
};

function buildPoiSuggestion(poi: POISuggestionItem): PlaceSuggestion {
  const keywords = Array.from(new Set([poi.district, poi.category, ...poi.tags].filter(Boolean)));
  return {
    value: poi.name,
    keywords,
    meta: [poi.district, poi.category].filter(Boolean).join(" · ")
  };
}

export function buildSuggestionCatalog(catalog: POISuggestionCatalogResponse): PlaceSuggestionCatalog {
  const poiSuggestions = catalog.pois.map(buildPoiSuggestion);

  return {
    originSuggestions: [CURRENT_LOCATION_SUGGESTION, ...poiSuggestions],
    mustVisitSuggestions: poiSuggestions,
    destinationSuggestions: poiSuggestions,
    districtSuggestions: catalog.districts.map((district) => ({ value: district, meta: "片区" }))
  };
}

export function emptySuggestionCatalog(): PlaceSuggestionCatalog {
  return buildSuggestionCatalog({
    pois: [],
    districts: []
  });
}

export function filterPlaceSuggestions(
  query: string,
  suggestions: PlaceSuggestion[],
  limit = 6
): PlaceSuggestion[] {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return suggestions.slice(0, limit);
  }

  return suggestions
    .map((item) => {
      const terms = [item.value, ...(item.keywords ?? [])].map((term) => term.toLowerCase());
      const rank = terms.reduce((best, term, index) => {
        if (!term.includes(normalized)) {
          return best;
        }

        if (term === normalized) {
          return Math.min(best, index === 0 ? 0 : 1);
        }

        if (term.startsWith(normalized)) {
          return Math.min(best, index === 0 ? 2 : 3);
        }

        return Math.min(best, index === 0 ? 12 : 13);
      }, Number.POSITIVE_INFINITY);

      return {
        item,
        rank
      };
    })
    .filter((entry) => Number.isFinite(entry.rank))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((entry) => entry.item);
}

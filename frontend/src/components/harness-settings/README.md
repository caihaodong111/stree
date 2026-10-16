# DeepSeek Harness settings components in STREE

Source: `deepseek-ai/deepseek-harness`, commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (MIT; see LICENSE).

The settings shell is adapted from `packages/client/ui-settings-general/src/client/SettingsRoot.tsx` and its CSS module. Provider rows and forms follow `ui-settings-models/src/client/ModelsSection.tsx`, `ProviderEditor.tsx`, and `CustomProviderCard.tsx`. `ModelListEditor.tsx`, `EditorFooter.tsx`, API key validation, model value helpers, copy, CSS modules, and the Button/Modal primitives are copied from those packages with local adaptations. The icon subset and scoped light theme tokens come from `ui-primitives` and `ui-theme`.

STREE supplies the section contents and uses its existing API for provider creation, atomic credential updates, model discovery, deletion, and planning selection. `adapter.ts` maps the source model editor's discovery calls onto that API; no Harness plugin runtime or settings.yaml service is required. Native modal dialogs provide focus trapping, nested Escape behavior, and background inertness. The navigation rail is removed; planning selection and provider management share one scrollable content column on desktop and mobile.

Local changes retain model search and the 200-model save limit, preserve configured model names, validate API addresses, and support explicit credential clearing. Optional per-model capacities survive storage; the model output limit is used when a provider-wide limit is absent. Context-window metadata is advisory and does not truncate planning input.

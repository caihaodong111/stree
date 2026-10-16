// Adapted from DeepSeek Harness ProviderEditor / CustomProviderCard (MIT).
// STREE saves each provider and its credential in one API request.
import { useMemo, useState, type FormEvent } from 'react';
import { ProviderInputSchema, type ProviderInput, type ProviderSummary } from '@stree/shared';
import { api } from '../../api';
import { createCatalogApi } from './adapter';
import { apiKeyFailure } from './apiKey';
import { EditorFooter } from './EditorFooter';
import { ModelListEditor, type ModelDraft } from './ModelListEditor';
import { validateDeepSeekModels } from './model-values';
import { zh } from './locales';
import { messageOf } from './utils';
import styles from './ModelsSection.module.css';

const t = (key: keyof typeof zh) => zh[key];
export function ProviderEditor({
  provider,
  taken,
  onClose,
  onSaved,
}: {
  provider: ProviderSummary | null;
  taken: string[];
  onClose: () => void;
  onSaved: (providers: ProviderSummary[], id: string) => void;
}) {
  const [route, setRoute] = useState(provider?.id || '');
  const [displayName, setDisplayName] = useState(provider?.name || '');
  const [baseURL, setBaseURL] = useState(provider?.baseURL || '');
  const [protocol, setProtocol] = useState<ProviderInput['protocol']>(
    provider?.protocol || 'openai-completions',
  );
  const [keyDraft, setKeyDraft] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [models, setModels] = useState<ModelDraft[]>(() =>
    (provider?.models || []).map(({ name, ...rest }) => ({ ...rest, ...(name ? { name } : {}) })),
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState(provider?.maxOutputTokens ?? null);
  const [jsonMode, setJsonMode] = useState(provider?.jsonMode ?? false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const catalogApi = useMemo(() => createCatalogApi(clearKey), [clearKey]);
  const keyFailure = apiKeyFailure(keyDraft);
  const modelFailure = validateDeepSeekModels(models);
  const routeTaken = !provider && taken.includes(route);
  const routeInvalid =
    Boolean(route) && (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(route) || route === 'codex');
  const addressValid = (() => {
    try {
      const url = new URL(baseURL);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  })();
  const ready = Boolean(
    route &&
    !routeTaken &&
    !routeInvalid &&
    addressValid &&
    models.length &&
    models.length <= 200 &&
    !modelFailure &&
    !keyFailure,
  );
  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    const parsed = ProviderInputSchema.safeParse({
      id: route,
      name: displayName.trim() || route,
      baseURL,
      protocol,
      models,
      apiKey: keyDraft,
      clearApiKey: clearKey,
      maxOutputTokens,
      jsonMode,
    });
    if (!parsed.success) {
      setFailure(parsed.error.issues[0]!.message);
      return;
    }
    setBusy(true);
    setFailure('');
    try {
      const saved = await api.saveProvider(parsed.data, Boolean(provider));
      setKeyDraft('');
      onSaved(saved.providers, route);
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const identityFields = (
    <>
      {!provider && (
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('customRoute')}</span>
          <input
            className={styles.input}
            aria-label={t('customRoute')}
            value={route}
            placeholder="acme-gateway"
            maxLength={60}
            onChange={(event) => setRoute(event.target.value)}
          />
          {routeInvalid || routeTaken ? (
            <p className={styles.error} role="alert">
              {t(routeInvalid ? 'customRouteInvalid' : 'customRouteTaken')}
            </p>
          ) : (
            <p className={styles.advancedHint}>{t('customRouteHint')}</p>
          )}
        </div>
      )}
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('customDisplayName')}</span>
        <input
          className={styles.input}
          aria-label={t('customDisplayName')}
          value={displayName}
          placeholder={route || '显示名称'}
          maxLength={100}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('baseUrl')}</span>
        <input
          className={styles.input}
          aria-label={t('baseUrl')}
          value={baseURL}
          placeholder="https://gateway.example/v1"
          onChange={(event) => setBaseURL(event.target.value)}
        />
        {baseURL && !addressValid && (
          <p className={styles.error}>请输入有效的 HTTP 或 HTTPS API 地址。</p>
        )}
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('customApi')}</span>
        <select
          className={`${styles.input} ${styles.selectInput}`}
          aria-label={t('customApi')}
          value={protocol}
          onChange={(event) => setProtocol(event.target.value as ProviderInput['protocol'])}
        >
          <option value="openai-completions">OpenAI Chat Completions</option>
          <option value="openai-responses">OpenAI Responses</option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
      </div>
    </>
  );
  const keyField = (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{t('keyInput')}</span>
      <input
        className={styles.input}
        type="password"
        autoComplete="new-password"
        aria-label={t('keyInput')}
        aria-invalid={Boolean(keyFailure)}
        value={keyDraft}
        placeholder={
          provider?.keyConfigured && !clearKey ? t('keyStored') : '输入 API 密钥（本地服务可留空）'
        }
        onChange={(event) => {
          setKeyDraft(event.target.value);
          setClearKey(false);
        }}
      />
      {keyFailure && (
        <p className={styles.error} role="alert">
          {t(keyFailure)}
        </p>
      )}
      {provider?.keyConfigured && (
        <label className={styles.checkboxField}>
          <input
            type="checkbox"
            checked={clearKey}
            onChange={(event) => {
              setClearKey(event.target.checked);
              if (event.target.checked) setKeyDraft('');
            }}
          />
          清除已保存的密钥
        </label>
      )}
    </div>
  );
  const modelFields = (
    <>
      <ModelListEditor
        models={models}
        onChange={setModels}
        overridden={provider ? true : undefined}
        onReset={
          provider
            ? () =>
                setModels(
                  provider.models.map(({ name, ...rest }) => ({
                    ...rest,
                    ...(name ? { name } : {}),
                  })),
                )
            : undefined
        }
        probe={{
          settingsNs: 'stree',
          ...(provider ? { provider: provider.id } : {}),
          baseURL,
          api: protocol,
          ...(keyDraft.trim() ? { apiKey: keyDraft.trim() } : {}),
        }}
        probeBlocked={keyFailure || (!addressValid ? 'fetchNeedsBaseUrl' : undefined)}
        api={catalogApi}
        t={t}
        disabled={busy}
      />
      <details className={styles.customized}>
        <summary className={styles.customizedSummary}>高级选项</summary>
        <div className={styles.customizedBody}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>提供方输出 Token 上限（选填）</span>
            <input
              className={styles.input}
              type="number"
              min={1}
              value={maxOutputTokens ?? ''}
              onChange={(event) =>
                setMaxOutputTokens(event.target.value ? Number(event.target.value) : null)
              }
              placeholder="由模型服务决定"
            />
          </label>
          {protocol === 'openai-completions' && (
            <label className={styles.checkboxField}>
              <input
                type="checkbox"
                checked={jsonMode}
                onChange={(event) => setJsonMode(event.target.checked)}
              />
              启用 JSON 模式
            </label>
          )}
        </div>
      </details>
    </>
  );
  return (
    <form
      className={styles.editor}
      aria-label={provider ? '编辑提供方' : '自定义提供方'}
      onSubmit={(event) => void save(event)}
    >
      <div className={styles.editorHeader}>
        <span className={styles.editorTitle}>{provider?.name || t('customTitle')}</span>
        {provider && provider.id !== provider.name && (
          <span className={styles.editorRoute}>{provider.id}</span>
        )}
      </div>
      <fieldset disabled={busy} className={styles.formFields}>
        {provider ? (
          keyField
        ) : (
          <>
            {identityFields}
            {keyField}
          </>
        )}
        {provider ? (
          <details className={styles.customized}>
            <summary className={styles.customizedSummary}>{t('customized')}</summary>
            <div className={styles.customizedBody}>
              {identityFields}
              {modelFields}
            </div>
          </details>
        ) : (
          modelFields
        )}
      </fieldset>
      {modelFailure && (
        <p className={styles.error} role="alert">
          {t('model')} {modelFailure.index + 1}：{t(modelFailure.key)}
        </p>
      )}
      {models.length > 200 && (
        <p className={styles.error} role="alert">
          每个提供方最多保存 200 个模型。
        </p>
      )}
      {failure && (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}
      <EditorFooter
        t={t}
        busy={busy}
        submitDisabled={busy || !ready}
        submitLabel={provider ? 'apply' : 'create'}
        submitBusyLabel={provider ? 'applying' : 'creating'}
        onCancel={onClose}
        onSubmit={() => void save()}
      />
    </form>
  );
}

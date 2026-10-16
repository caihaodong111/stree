import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ModelSettings, ModelSettingsResponse } from '@stree/shared';
import { api } from '../api';
import { SettingsPanel } from './harness-settings/SettingsPanel';
import { ModelsSection } from './harness-settings/ModelsSection';
import { Button } from './harness-settings/Button';
import styles from './harness-settings/ModelsSection.module.css';

export default function SettingsDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [data, setData] = useState<ModelSettingsResponse | null>(null);
  const [draft, setDraft] = useState<ModelSettings>({ model: null, effort: null });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const load = async (initial = false) => {
    if (initial) setLoading(true);
    setError('');
    try {
      const result = await api.modelSettings();
      if (!mounted.current) return;
      setData(result);
      setDraft((current) => {
        if (
          initial ||
          (current.model === data?.settings.model &&
            current.providerId === data.settings.providerId)
        )
          return result.settings;
        const selected = result.providers?.find((item) => item.id === current.providerId);
        return selected?.models.some((item) => item.id === current.model)
          ? current
          : result.settings;
      });
      if (!initial) onSaved();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '模型设置加载失败。');
    } finally {
      if (mounted.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void load(true);
    return () => {
      mounted.current = false;
    };
  }, []);
  const providers = data?.providers || [];
  const provider = providers.find((item) => item.id === draft.providerId);
  const saved = providers.find((item) => item.id === data?.settings.providerId);
  const dirty = Boolean(
    data && (draft.providerId !== data.settings.providerId || draft.model !== data.settings.model),
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await api.saveModelSettings(draft);
      if (!mounted.current) return;
      setData(result);
      setDraft(result.settings);
      setNotice('已保存，下次规划将使用新配置。');
      onSaved();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '保存失败，请重试。');
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const feedback = (
    <>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.savedNotice} role="status">
          {notice}
        </p>
      )}
    </>
  );
  const unavailable = (
    <div className={styles.section}>
      {loading ? (
        <p role="status">正在加载模型配置…</p>
      ) : (
        <>
          {feedback}
          <Button variant="outline" onClick={() => void load(true)}>
            重新加载
          </Button>
        </>
      )}
    </div>
  );
  return (
    <SettingsPanel
      onClose={onClose}
      models={data ? <ModelsSection data={data} onChanged={() => load()} /> : null}
      general={
        data ? (
          <form className={styles.section} onSubmit={(event) => void submit(event)}>
            <h2 className={styles.title}>规划设置</h2>
            <p className={styles.intro}>选择用于规划的模型，保存后用于新行程。</p>
            <fieldset className={styles.formFields} disabled={saving}>
              <label className={styles.field}>
                模型提供方
                <select
                  className={`${styles.input} ${styles.selectInput}`}
                  value={draft.providerId || ''}
                  disabled={!providers.length}
                  onChange={(event) => {
                    const id = event.target.value;
                    setDraft({
                      providerId: id,
                      model: providers.find((item) => item.id === id)?.models[0]?.id || null,
                      effort: null,
                    });
                    setNotice('');
                  }}
                >
                  {!draft.providerId && <option value="">请先添加模型提供方</option>}
                  {providers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                规划模型
                <select
                  className={`${styles.input} ${styles.selectInput}`}
                  value={draft.model || ''}
                  disabled={!provider}
                  onChange={(event) => {
                    setDraft({ ...draft, model: event.target.value, effort: null });
                    setNotice('');
                  }}
                >
                  {!provider && <option value="">请先添加模型</option>}
                  {provider?.models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name || item.id}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
            <p className={styles.intro} data-testid="current-planning-model">
              当前使用：{saved ? `${saved.name} · ${data.settings.model}` : '尚未配置规划模型'}
            </p>
            <p className={styles.advancedHint}>{dirty ? '有未保存的更改' : '已是最新配置'}</p>
            <div className={styles.editorActions}>
              <Button
                variant="outline"
                disabled={saving || !dirty}
                onClick={() => {
                  setDraft(data.settings);
                  setNotice('');
                  setError('');
                }}
              >
                撤销更改
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={saving || !dirty || !provider || !draft.model}
              >
                {saving ? '正在保存…' : '保存设置'}
              </Button>
            </div>
            {feedback}
          </form>
        ) : (
          unavailable
        )
      }
    />
  );
}

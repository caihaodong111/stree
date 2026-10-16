// Provider rows and expanded editor composition adapted from DeepSeek Harness (MIT).
import { useState } from 'react';
import type { ModelSettingsResponse, ProviderSummary } from '@stree/shared';
import { api } from '../../api';
import { ProviderEditor } from './ProviderEditor';
import { Button, Modal } from './primitives';
import { IconPlusOutline16 } from './icons';
import { messageOf } from './utils';
import { zh } from './locales';
import styles from './ModelsSection.module.css';

export function ModelsSection({
  data,
  onChanged,
}: {
  data: ModelSettingsResponse;
  onChanged: () => Promise<void>;
}) {
  const providers = data.providers || [];
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProviderSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState('');
  const [saved, setSaved] = useState('');
  const afterSave = async (_items: ProviderSummary[], id: string) => {
    setEditing(null);
    setAdding(false);
    setFailure('');
    await onChanged();
    setSaved(`已保存 ${id}。`);
  };
  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setFailure('');
    try {
      await api.deleteProvider(deleteTarget.id);
      setDeleteTarget(null);
      setSaved('提供方已删除。');
      await onChanged();
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setDeleting(false);
    }
  };
  return (
    <div className={styles.section}>
      <h2 className={styles.title}>{zh.title}</h2>
      <p className={styles.intro}>{zh.intro}</p>
      {saved && (
        <p className={styles.savedNotice} role="status">
          {saved}
        </p>
      )}
      <ul className={styles.rows}>
        {providers.map((provider) => (
          <li
            className={styles.rowCard}
            key={provider.id}
            data-testid="provider-card"
            aria-label={provider.name}
          >
            <div className={styles.rowHead}>
              <span className={styles.rowIdentity}>
                <span className={styles.rowName}>{provider.name}</span>
                <span className={styles.rowTag}>{zh.customTag}</span>
                <span
                  className={`${styles.credentialDot} ${provider.keyConfigured ? styles.credentialDotConfigured : styles.credentialDotMissing}`}
                  role="img"
                  aria-label={
                    provider.keyConfigured ? zh.credentialConfigured : zh.credentialMissing
                  }
                  title={provider.keyConfigured ? zh.credentialConfigured : zh.credentialMissing}
                />
                {data.settings.providerId === provider.id && (
                  <span className={styles.rowTag}>使用中</span>
                )}
              </span>
              <span className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  aria-label={`编辑 ${provider.name}`}
                  onClick={() => {
                    setAdding(false);
                    setEditing(editing === provider.id ? null : provider.id);
                    setSaved('');
                    setFailure('');
                  }}
                >
                  {zh.edit}
                </button>
                <button
                  type="button"
                  className={styles.dangerButton}
                  aria-label={`删除 ${provider.name}`}
                  disabled={data.settings.providerId === provider.id}
                  title={
                    data.settings.providerId === provider.id
                      ? '先切换规划提供方并保存，再删除'
                      : undefined
                  }
                  onClick={() => {
                    setDeleteTarget(provider);
                    setFailure('');
                  }}
                >
                  {zh.remove}
                </button>
              </span>
            </div>
            {editing === provider.id && (
              <ProviderEditor
                key={provider.id}
                provider={provider}
                taken={providers.map((item) => item.id)}
                onClose={() => setEditing(null)}
                onSaved={(items, id) => void afterSave(items, id)}
              />
            )}
          </li>
        ))}
      </ul>
      {!providers.length && <p className={styles.notice}>尚未配置规划模型，请先添加提供方。</p>}
      <div className={styles.addBlock}>
        {adding ? (
          <ProviderEditor
            provider={null}
            taken={providers.map((item) => item.id)}
            onClose={() => setAdding(false)}
            onSaved={(items, id) => void afterSave(items, id)}
          />
        ) : (
          <Button
            variant="outline"
            icon={<IconPlusOutline16 size={16} />}
            onClick={() => {
              setAdding(true);
              setEditing(null);
              setSaved('');
              setFailure('');
            }}
          >
            {zh.customAdd}
          </Button>
        )}
      </div>
      {failure && !deleteTarget && (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        title={`删除 ${deleteTarget?.name || ''}？`}
        closeLabel="关闭删除确认"
        description={`删除 ${deleteTarget?.name || ''} 会移除其配置和存储的 API 密钥。`}
        className={styles.deleteDialog}
        footer={
          <>
            <Button variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="outline"
              className={styles.deleteConfirm}
              disabled={deleting}
              onClick={() => void remove()}
            >
              {deleting ? '正在删除…' : '确定删除'}
            </Button>
          </>
        }
      >
        {failure && (
          <p className={styles.error} role="alert">
            {failure}
          </p>
        )}
      </Modal>
    </div>
  );
}

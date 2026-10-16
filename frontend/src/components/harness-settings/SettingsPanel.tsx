// Adapted from DeepSeek Harness SettingsRoot.tsx (MIT); STREE supplies section content.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconCloseOutline16 } from './icons';
import { clsx } from './utils';
import css from './SettingsRoot.module.css';
import './theme.css';

export function SettingsPanel({
  models,
  general,
  onClose,
}: {
  models: ReactNode;
  general: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element.showModal();
    closeButton.current?.focus();
    return () => {
      element.close();
      document.body.style.overflow = previous;
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className={clsx('harness-settings', css.overlay)}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel}>
        <div className={css.content}>
          <div className={css.header}>
            <h2 className={css.title} id={titleId}>
              设置
            </h2>
            <button
              ref={closeButton}
              type="button"
              className={css.close}
              aria-label="关闭设置"
              onClick={onClose}
            >
              <IconCloseOutline16 size={14} />
            </button>
          </div>
          <div className={css.options}>
            <div>{general}</div>
            <div>{models}</div>
          </div>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

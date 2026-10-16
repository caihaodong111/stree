import { useEffect, useRef, useState } from 'react';
import { ArrowUpLeft, Check, LoaderCircle, MapPin, Plus, X } from 'lucide-react';
import type { PlaceSuggestion } from '@stree/shared';
import { api } from '../api';
import { cachedPopularPlaces, loadPopularPlaces } from '../lib/popularPlaces';

export const placeNames = (value: string) =>
  value
    .split(/[，,、\n]/)
    .map((name) => name.trim())
    .filter(Boolean);

function Highlight({ name, keyword }: { name: string; keyword: string }) {
  const index = name.toLocaleLowerCase().indexOf(keyword.toLocaleLowerCase());
  if (index < 0 || !keyword) return <>{name}</>;
  return (
    <>
      {name.slice(0, index)}
      <mark>{name.slice(index, index + keyword.length)}</mark>
      {name.slice(index + keyword.length)}
    </>
  );
}

export default function PlaceAutocomplete({
  id,
  label,
  cityCode,
  value,
  selected,
  onChange,
  onSelect,
  onRemove,
  multiple = false,
  disabled = false,
}: {
  id: string;
  label: string;
  cityCode?: string;
  value: string;
  selected: Pick<PlaceSuggestion, 'id' | 'name' | 'address' | 'district'>[];
  onChange: (value: string) => void;
  onSelect: (place: PlaceSuggestion) => void;
  onRemove: (id: string) => void;
  multiple?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [active, setActive] = useState(-1);
  const [retry, setRetry] = useState(0);
  const [popularRetry, setPopularRetry] = useState(0);
  const [popular, setPopular] = useState<{
    city: string;
    places: PlaceSuggestion[];
    error: string;
  } | null>(null);
  const [result, setResult] = useState<{
    query: string;
    city?: string;
    places: PlaceSuggestion[];
    error: string;
  } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const activeOption = useRef<HTMLLIElement>(null);
  const keyword = (multiple ? (value.split(/[，,、\n]/).at(-1) ?? '') : value).trim();
  const full = multiple && selected.length >= 10;
  const isSelected = !multiple && selected[0]?.name === value;
  const showingPopular = multiple && !keyword && Boolean(cityCode);
  const visible =
    open && !disabled && !full && !composing && (Boolean(keyword) || showingPopular) && !isSelected;
  const cached = cityCode ? cachedPopularPlaces(cityCode) : undefined;
  const current = showingPopular
    ? cached
      ? { places: cached, error: '' }
      : popular?.city === cityCode
        ? popular
        : null
    : result?.query === keyword && result.city === cityCode
      ? result
      : null;
  const places = (current?.places ?? []).filter(
    (place) => !multiple || !selected.some((item) => item.id === place.id),
  );
  const listId = `${id}-suggestions`;

  useEffect(() => {
    if (!multiple || !cityCode || disabled) return;
    let cancelled = false;
    void loadPopularPlaces(cityCode)
      .then((places) => {
        if (!cancelled) setPopular({ city: cityCode, places, error: '' });
      })
      .catch((error) => {
        if (!cancelled)
          setPopular({
            city: cityCode,
            places: [],
            error: error instanceof Error ? error.message : '景点加载失败，请重试。',
          });
      });
    return () => {
      cancelled = true;
    };
  }, [multiple, cityCode, disabled, popularRetry]);

  useEffect(() => {
    setActive(-1);
  }, [keyword, cityCode, open]);

  useEffect(() => {
    if (!visible || showingPopular) return;
    const controller = new AbortController();
    setActive(-1);
    setResult(null);
    const timer = setTimeout(() => {
      void api
        .suggestPlaces(cityCode, keyword, controller.signal)
        .then(({ places }) => {
          if (controller.signal.aborted) return;
          setResult({ query: keyword, city: cityCode, places, error: '' });
          setActive(0);
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setResult({
              query: keyword,
              city: cityCode,
              places: [],
              error: error instanceof Error ? error.message : '地点查询失败，请重试。',
            });
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [visible, showingPopular, cityCode, keyword, retry]);

  useEffect(() => {
    activeOption.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (place: PlaceSuggestion) => {
    onSelect(place);
    if (multiple) {
      const separator = Math.max(...['，', ',', '、', '\n'].map((char) => value.lastIndexOf(char)));
      onChange(separator < 0 ? '' : value.slice(0, separator + 1));
    } else onChange(place.name);
    setActive(-1);
    setOpen(multiple);
    input.current?.focus();
  };

  return (
    <div
      className="place-autocomplete"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className="place-input-wrap">
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-label={label}
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={visible}
          aria-controls={visible ? listId : undefined}
          aria-activedescendant={visible && places[active] ? `${listId}-${active}` : undefined}
          aria-describedby={selected.length ? `${id}-selected` : undefined}
          value={value}
          disabled={disabled || full}
          maxLength={multiple ? 600 : 100}
          placeholder={
            full
              ? '已添加 10 个地点'
              : multiple
                ? selected.length
                  ? '继续添加想去的地点'
                  : '点击选热门景点，或搜索地点'
                : '酒店、车站，或一个具体地点'
          }
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => {
            if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              setOpen(false);
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
              if (places.length)
                setActive((index) =>
                  event.key === 'ArrowDown'
                    ? (index + 1) % places.length
                    : index <= 0
                      ? places.length - 1
                      : index - 1,
                );
            }
            if (event.key === 'Enter' && visible) {
              event.preventDefault();
              if (places[active]) choose(places[active]);
              else setOpen(false);
            }
          }}
        />
        {!multiple && value && (
          <button
            type="button"
            className="place-clear"
            aria-label="清空出发地点"
            disabled={disabled}
            onClick={() => {
              onChange('');
              onRemove(selected[0]?.id ?? '');
              input.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {visible && (
        <div className="place-dropdown">
          <ul id={listId} role="listbox" aria-label={`${label}候选`} className="place-options">
            {places.map((place, index) => (
              <li
                key={place.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                ref={index === active ? activeOption : undefined}
                className={`place-option${index === active ? ' is-active' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(place)}
                onMouseMove={() => setActive(index)}
              >
                <MapPin size={16} className="place-option-pin" />
                <div className="place-option-copy">
                  <span className="place-option-name">
                    <Highlight name={place.name} keyword={keyword} />
                  </span>
                  <span className="place-option-address">
                    {[place.district, place.address].filter(Boolean).join(' · ') || '地址待确认'}
                  </span>
                </div>
                {showingPopular ? (
                  <Plus size={14} className="place-option-arrow" />
                ) : (
                  <ArrowUpLeft size={14} className="place-option-arrow" />
                )}
              </li>
            ))}
          </ul>
          {!current && (
            <div className="place-search-state" role="status">
              <LoaderCircle size={14} className="place-spinner" />
              {showingPopular ? '正在加载热门景点…' : '正在查找地点…'}
            </div>
          )}
          {current?.error && (
            <div className="place-search-state" role="status">
              <span>{current.error}</span>
              <button
                type="button"
                onClick={() => {
                  if (showingPopular) {
                    setPopular(null);
                    setPopularRetry((value) => value + 1);
                  } else setRetry((value) => value + 1);
                }}
              >
                重试
              </button>
            </div>
          )}
          {current && !current.error && !places.length && (
            <div className="place-search-state" role="status">
              {current.places.length
                ? '这些地点已添加，可搜索其他地点。'
                : showingPopular
                  ? '暂无推荐景点，可输入名称搜索。'
                  : '未找到匹配地点，可补充名称或地址。'}
            </div>
          )}
        </div>
      )}
      {!!selected.length && (
        <div id={`${id}-selected`} className={multiple ? 'place-chips' : 'place-confirmation'}>
          {multiple ? (
            selected.map((place) => (
              <span
                className="place-chip"
                key={place.id}
                title={`${place.district} ${place.address}`}
              >
                <MapPin size={12} />
                <span>{place.name}</span>
                <button
                  type="button"
                  aria-label={`移除${place.name}（${place.address || place.district}）`}
                  disabled={disabled}
                  onClick={() => onRemove(place.id)}
                >
                  <X size={12} />
                </button>
              </span>
            ))
          ) : (
            <>
              <Check size={12} />
              <span>
                {[selected[0]?.district, selected[0]?.address].filter(Boolean).join(' · ') ||
                  '已选中地点'}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

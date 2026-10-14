import { Check, ChevronDown } from 'lucide-react';
import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';

interface Option {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
}

/** The <option> elements among the children (arrays and fragments included), in order. */
function readOptions(children: ReactNode): Option[] {
  const out: Option[] = [];
  const walk = (nodes: ReactNode) =>
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      const el = child as ReactElement<{ value?: unknown; children?: ReactNode; disabled?: boolean }>;
      if (el.type === Fragment) return walk(el.props.children);
      if (el.type === 'option') {
        const text = textOf(el.props.children);
        out.push({ value: el.props.value === undefined ? text : String(el.props.value), label: el.props.children, text, disabled: Boolean(el.props.disabled) });
      }
    });
  walk(children);
  return out;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

/** Width and placement classes belong on the wrapper; the rest style the button. */
const LAYOUT = /^(?:[a-z0-9]+:)*(?:w-|min-w-|max-w-|flex-|grow|shrink|basis-|col-|row-|self-|order-|m[trblxy]?-|-m[trblxy]?-)/;

const triggerClass =
  'press flex w-full items-center justify-between gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-left text-sm text-slate-900 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-60 aria-expanded:border-brand-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-slate-600';

/**
 * A styled dropdown with the same props as <select> (value, onChange, disabled, required, <option>
 * children). A hidden native select keeps form validation (`required`) working; onChange gets an
 * event whose `target.value` is the chosen option's value.
 */
export function Select({ children, value, defaultValue, onChange, disabled, className, required, name, id, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  const options = readOptions(children);
  const [inner, setInner] = useState(String(defaultValue ?? options[0]?.value ?? ''));
  const current = value !== undefined ? String(value) : inner;
  const selected = options.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const native = useRef<HTMLSelectElement>(null);
  const listId = useId();
  const typed = useRef({ text: '', at: 0 });

  const classes = (className ?? '').split(/\s+/).filter(Boolean);
  const wrapperClass = classes.filter((c) => LAYOUT.test(c)).join(' ');
  const buttonClass = classes.filter((c) => !LAYOUT.test(c)).join(' ');
  const compact = /\btext-xs\b/.test(buttonClass);

  const place_ = () => {
    const r = trigger.current!.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const width = Math.max(r.width, 160);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPlace(below < 240 && r.top > below ? { bottom: window.innerHeight - r.top + 6, left, width } : { top: r.bottom + 6, left, width });
  };

  const openList = () => {
    if (disabled) return;
    place_();
    const i = options.findIndex((o) => o.value === current);
    setActive(i >= 0 ? i : Math.max(0, options.findIndex((o) => !o.disabled)));
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) trigger.current?.focus({ preventScroll: true });
  };
  const choose = (o: Option) => {
    if (o.disabled) return;
    close();
    if (o.value === current) return;
    if (value === undefined) setInner(o.value);
    if (native.current) native.current.value = o.value;
    const target = { value: o.value, name: name ?? '' } as HTMLSelectElement;
    onChange?.({ target, currentTarget: target } as ChangeEvent<HTMLSelectElement>);
  };

  useLayoutEffect(() => {
    if (open) list.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (trigger.current?.contains(t) || list.current?.contains(t)) return;
      setOpen(false);
    };
    const scroll = (e: Event) => !list.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', outside);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', outside);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);

  const move = (from: number, step: number) => {
    for (let i = from + step; i >= 0 && i < options.length; i += step) if (!options[i].disabled) return i;
    return from;
  };
  const typeahead = (key: string) => {
    const now = Date.now();
    typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + key.toLowerCase(), at: now };
    const start = typed.current.text.length > 1 ? active : active + 1;
    const order = [...options.slice(start), ...options.slice(0, start)];
    const hit = order.find((o) => !o.disabled && o.text.toLowerCase().startsWith(typed.current.text));
    if (hit) setActive(options.indexOf(hit));
  };

  const onTriggerKey = (e: KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      openList();
    }
  };
  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') setActive((a) => move(a, 1));
    else if (e.key === 'ArrowUp') setActive((a) => move(a, -1));
    else if (e.key === 'Home') setActive(move(-1, 1));
    else if (e.key === 'End') setActive(move(options.length, -1));
    else if (e.key === 'Enter' || e.key === ' ') options[active] && choose(options[active]);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') return close(false);
    else if (e.key.length === 1) typeahead(e.key);
    else return;
    e.preventDefault();
  };

  return (
    <span className={`relative block ${wrapperClass}`}>
      <button
        {...(rest as Record<string, unknown>)}
        ref={trigger}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onTriggerKey}
        className={`${triggerClass} ${compact ? 'rounded-lg px-2.5 py-1' : ''} ${buttonClass}`}
      >
        <span className={`truncate ${selected?.value === '' ? 'text-slate-500 dark:text-slate-400' : ''}`}>{selected?.label ?? ' '}</span>
        <ChevronDown className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''} ${compact ? 'size-3.5' : 'size-4'}`} aria-hidden="true" />
      </button>
      {/* For forms: `required` validation and the submitted value. */}
      <select
        ref={native}
        name={name}
        required={required}
        disabled={disabled}
        value={current}
        onChange={() => undefined}
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-0"
        onFocus={() => trigger.current?.focus()}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.text}
          </option>
        ))}
      </select>
      {/* In <body>: inside a <label>, a click on an option would also "click" the label's button and reopen the list. */}
      {open &&
        place &&
        createPortal(
        <ul
          ref={list}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKey}
          style={{ top: place.top, bottom: place.bottom, left: place.left, minWidth: place.width }}
          className="fixed z-50 max-h-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg outline-none dark:border-slate-700 dark:bg-slate-900"
        >
          {options.map((o, i) => {
            const isSelected = o.value === current;
            return (
              <li
                key={`${o.value}-${i}`}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={isSelected}
                aria-disabled={o.disabled || undefined}
                onPointerEnter={() => !o.disabled && setActive(i)}
                onClick={() => choose(o)}
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg py-2 pr-3 pl-2.5 text-sm ${
                  o.disabled
                    ? 'cursor-not-allowed text-slate-400 dark:text-slate-600'
                    : isSelected
                      ? 'font-medium text-brand-700 dark:text-brand-100'
                      : 'text-slate-700 dark:text-slate-200'
                } ${i === active && !o.disabled ? 'bg-brand-50 dark:bg-slate-800' : ''}`}
              >
                <Check className={`size-4 shrink-0 ${isSelected ? '' : 'invisible'}`} aria-hidden="true" />
                <span className="truncate">{o.label}</span>
              </li>
            );
          })}
        </ul>,
          document.body,
        )}
    </span>
  );
}

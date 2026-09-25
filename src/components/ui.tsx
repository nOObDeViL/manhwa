'use client';

import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ---------------------------------- Button ---------------------------------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary: 'bg-violet-600 text-white hover:bg-violet-500 active:bg-violet-700 shadow-lg shadow-violet-950/40',
  secondary: 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700 active:bg-zinc-800 border border-zinc-700/60',
  ghost: 'text-zinc-300 hover:bg-zinc-800/70 hover:text-white',
  danger: 'bg-red-600/90 text-white hover:bg-red-500',
};

const sizes = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-5 text-base gap-2 rounded-xl',
};

export function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 select-none',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

/* ----------------------------------- Card ----------------------------------- */

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('rounded-2xl border border-zinc-800/80 bg-zinc-900/60 backdrop-blur', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800/80 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-zinc-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('p-4 sm:p-5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ---------------------------------- Inputs ---------------------------------- */

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 block text-xs font-medium text-zinc-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-zinc-500">{hint}</span>}
    </label>
  );
}

const inputBase =
  'w-full rounded-xl border border-zinc-700/70 bg-zinc-950/70 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-60';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputBase, 'h-10', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(inputBase, 'py-2 leading-relaxed', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(inputBase, 'h-10 appearance-none bg-no-repeat pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  hint?: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-medium text-zinc-300">{label}</span>
        <span className="font-mono text-zinc-400">{format ? format(value) : value}</span>
      </div>
      <input type="range" className="h-6 w-full" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-violet-600' : 'bg-zinc-700')}
      >
        <span className={cn('absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform', checked && 'translate-x-4')} />
      </button>
      <span className="min-w-0">
        <span className="block text-sm text-zinc-200">{label}</span>
        {hint && <span className="block text-[11px] text-zinc-500">{hint}</span>}
      </span>
    </label>
  );
}

/* --------------------------------- Feedback --------------------------------- */

export function Progress({ value, label, className }: { value: number; label?: ReactNode; className?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={className}>
      {label && (
        <div className="mb-1 flex justify-between gap-2 text-xs text-zinc-400">
          <span className="truncate">{label}</span>
          <span className="font-mono">{pct}%</span>
        </div>
      )}
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-500 transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Badge({ children, tone = 'default', className }: { children: ReactNode; tone?: 'default' | 'good' | 'warn' | 'bad' | 'accent'; className?: string }) {
  const tones = {
    default: 'bg-zinc-800 text-zinc-300',
    good: 'bg-emerald-500/15 text-emerald-300',
    warn: 'bg-amber-500/15 text-amber-300',
    bad: 'bg-red-500/15 text-red-300',
    accent: 'bg-violet-500/15 text-violet-300',
  };
  return <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', tones[tone], className)}>{children}</span>;
}

export function Notice({ kind = 'info', children, className }: { kind?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode; className?: string }) {
  const styles = {
    info: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    error: 'border-red-500/30 bg-red-500/10 text-red-200',
    success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  };
  const Icon = kind === 'success' ? CheckCircle2 : kind === 'info' ? Info : AlertTriangle;
  return (
    <div className={cn('flex gap-2.5 rounded-xl border px-3 py-2.5 text-sm', styles[kind], className)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 whitespace-pre-line break-words">{children}</div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-800 px-6 py-12 text-center">
      {icon && <div className="mb-3 text-zinc-600">{icon}</div>}
      <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
      {children && <div className="mt-1 max-w-md text-sm text-zinc-500">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-violet-400', className)} />;
}

/* ----------------------------------- Modal ---------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        className={cn(
          'flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-zinc-800 bg-zinc-900 shadow-2xl sm:rounded-2xl',
          wide ? 'sm:max-w-5xl' : 'sm:max-w-lg',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0 truncate text-sm font-semibold text-zinc-100">{title}</div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-800 px-4 py-3 safe-bottom">{footer}</div>}
      </div>
    </div>
  );
}

export function LogView({ lines, className }: { lines: string[]; className?: string }) {
  return (
    <pre className={cn('max-h-48 overflow-auto rounded-xl border border-zinc-800 bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-zinc-400', className)}>
      {lines.length ? lines.join('\n') : 'No output yet.'}
    </pre>
  );
}

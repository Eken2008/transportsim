import { useApp } from '../store.ts';

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`panel toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

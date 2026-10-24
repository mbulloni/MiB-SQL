import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem = { label: string; action: () => void; disabled?: boolean; danger?: boolean } | 'sep';

let show: (x: number, y: number, items: MenuItem[]) => void = () => {};

export const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
  e.preventDefault();
  e.stopPropagation();
  show(e.clientX, e.clientY, items);
};

/** Single context menu host, mounted once in App. */
export default function ContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  show = (x, y, items) => setMenu({ x, y, items });

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', key); };
  }, [menu]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight) el.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
    if (r.right > window.innerWidth) el.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`;
  }, [menu]);

  if (!menu) return null;
  return (
    <div className="ctx" ref={ref} style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
      {menu.items.map((it, i) => it === 'sep' ? <div key={i} className="sep" /> : (
        <button key={i} disabled={it.disabled} className={it.danger ? 'danger' : ''} onClick={() => { setMenu(null); it.action(); }}>{it.label}</button>
      ))}
    </div>
  );
}

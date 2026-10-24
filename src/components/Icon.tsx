import type { ReactElement } from 'react';

// Small inline icons for the explorer and toolbars (16px, currentColor unless a tint is part of the meaning).
const P: Record<string, ReactElement> = {
  server: <><rect x="2" y="2" width="12" height="5" rx="1" fill="#5b7fb5" /><rect x="2" y="9" width="12" height="5" rx="1" fill="#5b7fb5" /><circle cx="4.5" cy="4.5" r=".9" fill="#fff" /><circle cx="4.5" cy="11.5" r=".9" fill="#fff" /></>,
  database: <><ellipse cx="8" cy="3.5" rx="5.5" ry="2" fill="#d99b2b" /><path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9c0 1.1-2.5 2-5.5 2s-5.5-.9-5.5-2z" fill="#e8b04a" /></>,
  folder: <path d="M1.5 3.5h5l1.5 1.5h6.5v8.5h-13z" fill="#e9c46a" stroke="#c9a23e" strokeWidth=".8" />,
  table: <><rect x="1.5" y="2.5" width="13" height="11" fill="#fff" stroke="#3a7bd5" /><rect x="1.5" y="2.5" width="13" height="3" fill="#3a7bd5" /><path d="M1.5 9h13M6 5.5v8M10.5 5.5v8" stroke="#3a7bd5" strokeWidth=".8" /></>,
  view: <><rect x="1.5" y="2.5" width="13" height="11" fill="#fff" stroke="#2a9d8f" /><rect x="1.5" y="2.5" width="13" height="3" fill="#2a9d8f" /><circle cx="8" cy="9.5" r="2.2" fill="none" stroke="#2a9d8f" /></>,
  procedure: <><rect x="2" y="2" width="12" height="12" rx="2" fill="#8e5cc4" /><path d="M5 5h3.5a2 2 0 010 4H5zM5 5v6" stroke="#fff" strokeWidth="1.3" fill="none" /></>,
  function: <><rect x="2" y="2" width="12" height="12" rx="2" fill="#c45c9c" /><path d="M10 4.5H8.5c-1 0-1.5.6-1.5 1.5v6M5.5 8h4" stroke="#fff" strokeWidth="1.3" fill="none" /></>,
  trigger: <path d="M9 1.5L3.5 9h4L6.5 14.5 12.5 7h-4z" fill="#e76f51" />,
  event: <><circle cx="8" cy="8" r="6" fill="#fff" stroke="#457b9d" strokeWidth="1.2" /><path d="M8 4.5V8l2.5 1.5" stroke="#457b9d" strokeWidth="1.2" fill="none" /></>,
  column: <><rect x="3" y="3" width="10" height="10" fill="#fff" stroke="#7a8696" /><rect x="6" y="3" width="4" height="10" fill="#9bb4d6" /></>,
  key: <><circle cx="5" cy="8" r="3" fill="none" stroke="#d4a017" strokeWidth="1.6" /><path d="M8 8h6M12 8v2.5M10 8v2" stroke="#d4a017" strokeWidth="1.6" /></>,
  index: <><path d="M3 3h10M3 6.5h7M3 10h10M3 13.5h5" stroke="#5b7fb5" strokeWidth="1.5" /></>,
  fk: <><circle cx="4.5" cy="8" r="2.5" fill="none" stroke="#2a9d8f" strokeWidth="1.5" /><path d="M7 8h7M11 5l3 3-3 3" stroke="#2a9d8f" strokeWidth="1.5" fill="none" /></>,
  play: <path d="M4 2.5v11l9-5.5z" fill="#2e9e44" />,
  playLine: <><path d="M2 3.5v9l7-4.5z" fill="#2e9e44" /><path d="M11 4h3M11 8h3M11 12h3" stroke="#2e9e44" strokeWidth="1.4" /></>,
  stop: <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="#d64545" />,
  plan: <><rect x="1.5" y="2" width="5" height="3.5" fill="#3a7bd5" /><rect x="9.5" y="6.5" width="5" height="3.5" fill="#3a7bd5" /><rect x="9.5" y="11" width="5" height="3.5" fill="#3a7bd5" /><path d="M4 5.5v7h5.5M4 8.2h5.5" stroke="#3a7bd5" fill="none" /></>,
  newSql: <><path d="M3 1.5h6.5l3.5 3.5v9.5H3z" fill="#fff" stroke="#6a7685" /><path d="M5 8h6M5 10.5h6M5 13h4" stroke="#3a7bd5" /><circle cx="12.5" cy="3.5" r="3" fill="#2e9e44" /><path d="M12.5 2v3M11 3.5h3" stroke="#fff" /></>,
  open: <path d="M1.5 4h4.5l1.5 1.5h6v1.5H5l-2 6.5H1.5zM5 7h10l-2.5 6.5H3z" fill="#e9c46a" stroke="#c9a23e" strokeWidth=".7" />,
  save: <><rect x="2" y="2" width="12" height="12" rx="1" fill="#3a7bd5" /><rect x="4.5" y="2" width="7" height="4.5" fill="#fff" /><rect x="4" y="9" width="8" height="5" fill="#dfe8f6" /></>,
  plug: <><path d="M5 1.5v3.5M11 1.5v3.5" stroke="#6a7685" strokeWidth="1.5" /><path d="M3 5h10v3a5 5 0 01-10 0z" fill="#2e9e44" /><path d="M8 13v2" stroke="#6a7685" strokeWidth="1.5" /></>,
  unplug: <><path d="M5 1.5v3.5M11 1.5v3.5" stroke="#6a7685" strokeWidth="1.5" /><path d="M3 5h10v3a5 5 0 01-10 0z" fill="#9aa3ad" /><path d="M2 14L14 2" stroke="#d64545" strokeWidth="1.5" /></>,
  refresh: <path d="M13 8a5 5 0 11-1.5-3.5M13 2v3h-3" stroke="#3a7bd5" strokeWidth="1.6" fill="none" />,
  addConn: <><rect x="1.5" y="3" width="10" height="4" rx="1" fill="#5b7fb5" /><rect x="1.5" y="9" width="10" height="4" rx="1" fill="#5b7fb5" /><circle cx="12.5" cy="12" r="3" fill="#2e9e44" /><path d="M12.5 10.5v3M11 12h3" stroke="#fff" /></>,
  sun: <><circle cx="8" cy="8" r="3.2" fill="#e0a800" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" stroke="#e0a800" strokeWidth="1.4" strokeLinecap="round" /></>,
  moon: <path d="M12.5 10.5A5.5 5.5 0 015.5 3.5a5.5 5.5 0 107 7z" fill="#9db8ff" />,
  close: <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" />,
};

export default function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">{P[name]}</svg>;
}

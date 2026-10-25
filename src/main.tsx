import { createRoot } from 'react-dom/client';
import * as actions from './actions';
import { monaco } from './editor';
import { applyTheme, setThemePref } from './theme';
import { useStore } from './store';
import { api } from './api';
import { getLang } from './i18n';
import App from './App';
import './styles.css';

// Hook for the screenshot/smoke scripts (MIBSQL_SCRIPT) that drive the UI from outside.
(window as unknown as { __mib: unknown }).__mib = { useStore, actions, monaco, setThemePref };

applyTheme();
document.documentElement.lang = getLang();
api.setLang(getLang()).catch(() => {});

createRoot(document.getElementById('root')!).render(<App />);

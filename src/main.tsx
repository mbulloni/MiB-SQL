import { createRoot } from 'react-dom/client';
import * as actions from './actions';
import { monaco } from './editor';
import { useStore } from './store';
import App from './App';
import './styles.css';

// Hook for the screenshot/smoke scripts (MIBSQL_SCRIPT) that drive the UI from outside.
(window as unknown as { __mib: unknown }).__mib = { useStore, actions, monaco };

createRoot(document.getElementById('root')!).render(<App />);

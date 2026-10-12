import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { resetHistory } from './store/history';
resetHistory('Session start');

// Global error surface — never fail silently.
window.addEventListener('unhandledrejection', (e) => { import('./store/store').then(({ S }) => S().notify('CRITICAL', `Unexpected error: ${e.reason?.message ?? e.reason}`)); });
window.addEventListener('error', (e) => { import('./store/store').then(({ S }) => S().notify('CRITICAL', `Unexpected error: ${e.message}`)); });

createRoot(document.getElementById('root')!).render(<App />);

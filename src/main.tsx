import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root 未找到');

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

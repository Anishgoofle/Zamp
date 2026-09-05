import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MergeWorkbench } from './containers/MergeWorkbench';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <MergeWorkbench />
  </StrictMode>,
);

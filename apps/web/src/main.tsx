import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { loadConfig } from './lib/config';

const root = createRoot(document.getElementById('root')!);

loadConfig()
  .then(() =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  )
  .catch((err) => {
    root.render(<p style={{ padding: 24 }}>JoyBot could not start: {String(err.message ?? err)}</p>);
  });

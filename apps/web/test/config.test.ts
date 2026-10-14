import { describe, expect, it } from 'vitest';
import { apiUrl, setConfig } from '../src/lib/config';

describe('apiUrl', () => {
  it('uses the API host when it has its own (deployed on another domain)', () => {
    setConfig({ environment: 'production', apiBase: 'https://api.appjoy.dev/api' });
    expect(apiUrl('/mcp', 'https://appjoy.dev')).toBe('https://api.appjoy.dev/api/mcp');
  });

  it('uses this origin when the API is under /api (local development, AWS)', () => {
    setConfig({ environment: 'local', apiBase: '/api' });
    expect(apiUrl('/mcp', 'http://localhost:5173')).toBe('http://localhost:5173/api/mcp');
    setConfig({ environment: 'production', apiBase: '/api/' });
    expect(apiUrl('/mcp', 'https://app.example.com')).toBe('https://app.example.com/api/mcp');
  });
});

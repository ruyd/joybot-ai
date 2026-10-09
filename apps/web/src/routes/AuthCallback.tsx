import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ErrorBanner, Spinner } from '../components/ui';
import { completeSignIn } from '../lib/auth';

export function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // React strict mode runs effects twice; the code is single-use
    started.current = true;
    completeSignIn()
      .then((to) => navigate(to, { replace: true }))
      .catch(setError);
  }, [navigate]);
  return <main className="p-6">{error ? <ErrorBanner error={error} /> : <Spinner label="Signing you in" />}</main>;
}

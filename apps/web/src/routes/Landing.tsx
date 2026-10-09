import { Link } from 'react-router-dom';

export function Landing() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-3">
        <img src="/favicon.svg" alt="" className="size-10" />
        <h1 className="text-2xl font-semibold tracking-tight">JoyBot</h1>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link to="/portal" className="rounded-xl border border-slate-200 bg-white p-6 transition hover:border-brand-500 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-semibold">Customer portal</h2>
          <p className="mt-1 text-sm text-slate-500">Your appointments, payments and services — or just ask.</p>
        </Link>
        <Link to="/staff" className="rounded-xl border border-slate-200 bg-white p-6 transition hover:border-brand-500 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-semibold">Staff console</h2>
          <p className="mt-1 text-sm text-slate-500">Customers, payments and your schedule, with the assistant.</p>
        </Link>
      </div>
    </main>
  );
}

import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Keeps one broken page from blanking the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="mx-auto max-w-xl px-4 py-10">
        <h1 className="text-lg font-semibold">Something went wrong on this page</h1>
        <p className="mt-2 text-sm text-slate-500">Try again, or go back. If it keeps happening, let us know.</p>
        <button className="mt-4 rounded-lg bg-brand-600 px-3 py-2 text-sm text-white" onClick={() => this.setState({ error: undefined })}>
          Try again
        </button>
      </main>
    );
  }
}

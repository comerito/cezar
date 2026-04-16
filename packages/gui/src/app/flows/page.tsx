export default function FlowsPage() {
  return (
    <div className="px-8 py-6">
      <header className="mb-6 border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">My Flows</h1>
        <p className="mt-1 text-sm text-fg-muted">Autofix runs you initiated — scoped to your user via Supabase RLS.</p>
      </header>
      <div className="rounded-lg border border-dashed border-border bg-bg-elevated p-8 text-center text-sm text-fg-muted">
        Phase 2 — the live cockpit renders here. Currently just a route shell.
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="px-8 py-6">
      <header className="mb-6 border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-fg-muted">Workspace config exposed from .issuemanagerrc.json.</p>
      </header>
      <div className="rounded-lg border border-dashed border-border bg-bg-elevated p-8 text-center text-sm text-fg-muted">
        Phase 1 — full settings pane. Route shell for now.
      </div>
    </div>
  );
}

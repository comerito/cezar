export default async function CockpitPage({ params }: { params: Promise<{ flowId: string }> }) {
  const { flowId } = await params;
  return (
    <div className="px-8 py-6">
      <header className="mb-6 border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Cockpit</h1>
        <p className="mt-1 text-sm text-fg-muted">Flow {flowId}</p>
      </header>
      <div className="grid grid-cols-[260px_1fr_260px] gap-4">
        <Pane title="Stage tracker" body="analyze → fix → commit → review → push → PR" />
        <Pane title="Agent activity" body="AgentEvent stream wires here in Phase 2." />
        <Pane title="Budget + artifacts" body="Tokens, model, branch, worktree." />
      </div>
    </div>
  );
}

function Pane({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-elevated p-4">
      <div className="mb-2 text-xs uppercase tracking-wider text-fg-subtle">{title}</div>
      <div className="text-sm text-fg-muted">{body}</div>
    </div>
  );
}

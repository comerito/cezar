import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface WeekBucket {
  week: string;
  opened: number;
  closed: number;
}

export interface FlowOutcomeBucket {
  status: string;
  count: number;
}

export interface CostEntry {
  flowId: string;
  issueNumber: number;
  tokensUsed: number;
  status: string;
  createdAt: string;
}

export interface DistributionEntry {
  label: string;
  count: number;
}

export interface AnalyticsData {
  velocity: WeekBucket[];
  flowOutcomes: FlowOutcomeBucket[];
  costs: CostEntry[];
  totalTokens: number;
  priorityDist: DistributionEntry[];
  typeDist: DistributionEntry[];
  labelDist: DistributionEntry[];
}

export async function loadAnalytics(workspaceId: string): Promise<AnalyticsData | null> {
  try {
    const supabase = await createSupabaseServerClient();

    const [{ data: issues }, { data: flows }] = await Promise.all([
      supabase.from('issues').select('number, state, labels, analysis, created_at').eq('workspace_id', workspaceId),
      supabase.from('flows').select('id, issue_number, status, outcome, created_at').eq('workspace_id', workspaceId).order('created_at', { ascending: false }),
    ]);

    const allIssues = issues ?? [];
    const allFlows = flows ?? [];

    // Velocity: issues opened per week (last 12 weeks)
    const velocity = buildVelocity(allIssues);

    // Flow outcomes
    const outcomeCounts = new Map<string, number>();
    for (const f of allFlows) {
      outcomeCounts.set(f.status, (outcomeCounts.get(f.status) ?? 0) + 1);
    }
    const flowOutcomes = [...outcomeCounts.entries()].map(([status, count]) => ({ status, count }));

    // Cost tracking
    const costs: CostEntry[] = allFlows.map((f) => {
      const outcome = f.outcome as any;
      return {
        flowId: f.id,
        issueNumber: f.issue_number,
        tokensUsed: outcome?.tokensUsed ?? 0,
        status: f.status,
        createdAt: f.created_at,
      };
    });
    const totalTokens = costs.reduce((s, c) => s + c.tokensUsed, 0);

    // Priority distribution
    const priCounts = new Map<string, number>();
    for (const i of allIssues) {
      const pri = (i.analysis as any)?.priority;
      if (pri) priCounts.set(pri, (priCounts.get(pri) ?? 0) + 1);
    }
    const priorityDist = [...priCounts.entries()].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    // Type distribution
    const typeCounts = new Map<string, number>();
    for (const i of allIssues) {
      const t = (i.analysis as any)?.issueType;
      if (t) typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }
    const typeDist = [...typeCounts.entries()].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    // Top labels
    const labelCounts = new Map<string, number>();
    for (const i of allIssues) {
      for (const l of (i.labels as string[]) ?? []) {
        labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
      }
    }
    const labelDist = [...labelCounts.entries()].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);

    return { velocity, flowOutcomes, costs, totalTokens, priorityDist, typeDist, labelDist };
  } catch {
    return null;
  }
}

function buildVelocity(issues: Array<{ state: string; created_at: string }>): WeekBucket[] {
  const weeks = 12;
  const now = Date.now();
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const buckets: WeekBucket[] = [];

  for (let i = weeks - 1; i >= 0; i--) {
    const start = now - (i + 1) * msPerWeek;
    const end = now - i * msPerWeek;
    const weekLabel = new Date(start).toISOString().slice(5, 10);
    const opened = issues.filter((is) => {
      const t = new Date(is.created_at).getTime();
      return t >= start && t < end;
    }).length;
    buckets.push({ week: weekLabel, opened, closed: 0 });
  }

  return buckets;
}

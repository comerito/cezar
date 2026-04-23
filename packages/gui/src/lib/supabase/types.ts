// Hand-written type map for the initial schema.
// TODO: replace with `supabase gen types typescript` output once the project
// is linked (`supabase link --project-ref <ref>`).

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type WorkspaceRole = 'admin' | 'actor' | 'viewer';

export type FlowStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'pr-opened';

export type CiStatus = 'pending' | 'success' | 'failure' | 'neutral' | 'unknown';

export interface CiFailedCheck {
  name: string;
  conclusion: string | null;
  htmlUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export type CiAttributionVerdict = 'ours' | 'unrelated' | 'flaky' | 'unsure';
export type CiAttributionMethod = 'base-branch-control' | 'llm' | 'degraded';

export interface CiAttribution {
  verdict: CiAttributionVerdict;
  confidence: number;
  method: CiAttributionMethod;
  reasoning: string;
  preExistingChecks: string[];
  suggestedFocus?: string;
  model?: string;
  attributedAt: string;
}

export interface Database {
  public: {
    Tables: {
      workspaces: {
        Row: {
          id: string;
          slug: string;
          name: string;
          repo_owner: string;
          repo_name: string;
          installation_id: string | null;
          config: Json;
          meta: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['workspaces']['Row'], 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['workspaces']['Insert']>;
      };
      workspace_members: {
        Row: {
          workspace_id: string;
          user_id: string;
          role: WorkspaceRole;
          joined_at: string;
        };
        Insert: Database['public']['Tables']['workspace_members']['Row'];
        Update: Partial<Database['public']['Tables']['workspace_members']['Row']>;
      };
      issues: {
        Row: {
          id: string;
          workspace_id: string;
          number: number;
          title: string;
          body: string;
          state: 'open' | 'closed';
          labels: string[];
          assignees: string[];
          author: string;
          html_url: string;
          content_hash: string;
          comment_count: number;
          reactions: number;
          comments: Json;
          comments_fetched_at: string | null;
          digest: Json | null;
          analysis: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['issues']['Row'], 'id'> & { id?: string };
        Update: Partial<Database['public']['Tables']['issues']['Insert']>;
      };
      flows: {
        Row: {
          id: string;
          workspace_id: string;
          actor_id: string;
          issue_number: number;
          status: FlowStatus;
          mode: 'apply' | 'dry-run';
          branch: string | null;
          pr_url: string | null;
          pr_number: number | null;
          outcome: Json | null;
          attempts: Json;
          head_sha: string | null;
          ci_status: CiStatus | null;
          ci_checked_at: string | null;
          ci_failed_checks: Json;
          ci_attribution: Json | null;
          ci_attribution_checked_at: string | null;
          ci_flaky_reruns: number;
          ci_attribution_in_progress: boolean;
          ci_fix_attempts: number;
          ci_fix_in_progress: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['flows']['Row'], 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['flows']['Insert']>;
      };
      flow_events: {
        Row: {
          id: string;
          flow_id: string;
          type: 'lifecycle' | 'agent';
          payload: Json;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['flow_events']['Row'], 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['flow_events']['Insert']>;
      };
      user_github_tokens: {
        Row: {
          user_id: string;
          provider_token: string;
          provider_refresh_token: string | null;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['user_github_tokens']['Row'], 'updated_at'> & {
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['user_github_tokens']['Insert']>;
      };
    };
  };
}

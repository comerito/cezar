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

export type WorkflowBackend = 'anthropic-api' | 'claude-cli' | 'codex-cli';

// ─── Phase 3a: job queue + run/event tables ─────────────────────────────
// Note: `@cezar/core` also exports a `WorkflowRunStatus` (the in-process engine
// state). These are the *DB* string sets — kept local + named distinctly to
// avoid confusing the two.
export type JobKind = 'triage' | 'autofix' | 'ci-followup';
export type JobStatus = 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'cancelled';
export type DbWorkflowRunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export type AgentRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped';
export type AgentRunStepKind = 'agent' | 'effect' | 'human-gate' | 'commit' | 'open-pr' | 'push';
export type AgentRunEventType =
  | 'lifecycle'
  | 'agent-text'
  | 'tool-call'
  | 'tool-result'
  | 'note'
  | 'step-start'
  | 'step-end';
export type RunnerKind = 'cloud' | 'self-hosted';
export type RunnerStatus = 'online' | 'offline' | 'draining';

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
          auto_triage_enabled: boolean;
          autofix_enabled: boolean;
          separate_comment_per_step: boolean;
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
      workflow_bindings: {
        Row: {
          id: string;
          workspace_id: string;
          repo: string | null;
          step_id: string;
          skill_name: string | null;
          backend: WorkflowBackend | null;
          model: string | null;
          extra_tools: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['workflow_bindings']['Row'], 'id' | 'extra_tools' | 'created_at' | 'updated_at'> & {
          id?: string;
          repo?: string | null;
          skill_name?: string | null;
          backend?: WorkflowBackend | null;
          model?: string | null;
          extra_tools?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['workflow_bindings']['Insert']>;
      };
      repo_skills: {
        Row: {
          workspace_id: string;
          repo: string;
          commit_sha: string | null;
          skills: Json;
          fetched_at: string;
        };
        Insert: Omit<Database['public']['Tables']['repo_skills']['Row'], 'commit_sha' | 'skills' | 'fetched_at'> & {
          commit_sha?: string | null;
          skills?: Json;
          fetched_at?: string;
        };
        Update: Partial<Database['public']['Tables']['repo_skills']['Insert']>;
      };
      jobs: {
        Row: {
          id: string;
          workspace_id: string;
          repo: string | null;
          kind: JobKind;
          issue_number: number | null;
          pr_number: number | null;
          priority: number;
          status: JobStatus;
          required_backend: WorkflowBackend | null;
          claimed_by_runner: string | null;
          attempts: number;
          max_attempts: number;
          scheduled_at: string;
          payload: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<
          Database['public']['Tables']['jobs']['Row'],
          'id' | 'priority' | 'status' | 'attempts' | 'max_attempts' | 'scheduled_at' | 'payload' | 'created_at' | 'updated_at'
        > & {
          id?: string;
          repo?: string | null;
          issue_number?: number | null;
          pr_number?: number | null;
          priority?: number;
          status?: JobStatus;
          required_backend?: WorkflowBackend | null;
          claimed_by_runner?: string | null;
          attempts?: number;
          max_attempts?: number;
          scheduled_at?: string;
          payload?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['jobs']['Insert']>;
      };
      workflow_runs: {
        Row: {
          id: string;
          workspace_id: string;
          job_id: string | null;
          workflow: string;
          repo: string | null;
          issue_number: number | null;
          pr_number: number | null;
          branch: string | null;
          head_sha: string | null;
          pr_url: string | null;
          status: DbWorkflowRunStatus;
          pause_requested: boolean;
          current_step_id: string | null;
          outcome: Json | null;
          reason: string | null;
          tokens_used: number;
          cost_estimate: number | null;
          started_at: string;
          finished_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<
          Database['public']['Tables']['workflow_runs']['Row'],
          'id' | 'status' | 'pause_requested' | 'tokens_used' | 'started_at' | 'created_at' | 'updated_at'
        > & {
          id?: string;
          job_id?: string | null;
          repo?: string | null;
          issue_number?: number | null;
          pr_number?: number | null;
          branch?: string | null;
          head_sha?: string | null;
          pr_url?: string | null;
          status?: DbWorkflowRunStatus;
          pause_requested?: boolean;
          current_step_id?: string | null;
          outcome?: Json | null;
          reason?: string | null;
          tokens_used?: number;
          cost_estimate?: number | null;
          started_at?: string;
          finished_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['workflow_runs']['Insert']>;
      };
      agent_runs: {
        Row: {
          id: string;
          workspace_id: string;
          workflow_run_id: string;
          step_id: string;
          iteration: number;
          kind: AgentRunStepKind | null;
          backend: string | null;
          model: string | null;
          status: AgentRunStatus;
          started_at: string;
          finished_at: string | null;
          tokens_used: number;
          cost_estimate: number | null;
          summary: string | null;
          error: string | null;
        };
        Insert: Omit<
          Database['public']['Tables']['agent_runs']['Row'],
          'id' | 'iteration' | 'status' | 'started_at' | 'tokens_used'
        > & {
          id?: string;
          iteration?: number;
          kind?: AgentRunStepKind | null;
          backend?: string | null;
          model?: string | null;
          status?: AgentRunStatus;
          started_at?: string;
          finished_at?: string | null;
          tokens_used?: number;
          cost_estimate?: number | null;
          summary?: string | null;
          error?: string | null;
        };
        Update: Partial<Database['public']['Tables']['agent_runs']['Insert']>;
      };
      agent_run_events: {
        Row: {
          id: number;
          workspace_id: string;
          workflow_run_id: string;
          agent_run_id: string | null;
          type: AgentRunEventType;
          payload: Json;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['agent_run_events']['Row'], 'id' | 'payload' | 'created_at'> & {
          id?: number;
          agent_run_id?: string | null;
          payload?: Json;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['agent_run_events']['Insert']>;
      };
      runners: {
        Row: {
          id: string;
          workspace_id: string | null;
          name: string;
          kind: RunnerKind;
          backends: string[];
          models: string[];
          token_hash: string | null;
          status: RunnerStatus;
          last_heartbeat_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<
          Database['public']['Tables']['runners']['Row'],
          'id' | 'backends' | 'models' | 'status' | 'created_at' | 'updated_at'
        > & {
          id?: string;
          workspace_id?: string | null;
          backends?: string[];
          models?: string[];
          token_hash?: string | null;
          status?: RunnerStatus;
          last_heartbeat_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['runners']['Insert']>;
      };
    };
  };
}

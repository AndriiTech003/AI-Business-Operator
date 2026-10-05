CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"user_name" text,
	"playbook_id" uuid,
	"goal" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stop_reason" text,
	"policy_version" integer NOT NULL,
	"prompt_version" integer NOT NULL,
	"model" text NOT NULL,
	"budget" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"context" jsonb,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"system_prompt" text,
	"tools" jsonb,
	"hidden_tools" jsonb,
	"prompt_now" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"summary" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'done' NOT NULL,
	"tool" text,
	"tool_use_id" text,
	"args" jsonb,
	"result" jsonb,
	"policy_decision" jsonb,
	"taint" jsonb,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eval_run_id" uuid NOT NULL,
	"scenario_id" text NOT NULL,
	"category" text NOT NULL,
	"model" text NOT NULL,
	"passed" boolean NOT NULL,
	"violations" integer NOT NULL,
	"injection_success" boolean NOT NULL,
	"steps" integer NOT NULL,
	"tool_calls" integer NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" double precision NOT NULL,
	"latency_ms" integer NOT NULL,
	"first_token_ms" integer,
	"judge_score" double precision,
	"failures" jsonb NOT NULL,
	"trajectory" jsonb NOT NULL,
	"agent_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" text NOT NULL,
	"models" jsonb NOT NULL,
	"scenario_count" integer NOT NULL,
	"passed" integer NOT NULL,
	"failed" integer NOT NULL,
	"violations" integer NOT NULL,
	"injection_success" integer NOT NULL,
	"gates_passed" boolean NOT NULL,
	"avg_steps" double precision NOT NULL,
	"avg_cost_usd" double precision NOT NULL,
	"report_path" text,
	"report_md" text,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interventions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_by" uuid,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"instructions" text NOT NULL,
	"schedule" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"policy_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"source" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_tenant_id_version_pk" PRIMARY KEY("tenant_id","version")
);
--> statement-breakpoint
CREATE TABLE "proposal_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'collecting' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"external_approval_id" uuid,
	"published_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"args_hash" text NOT NULL,
	"approved_hash" text,
	"original_args" jsonb,
	"preview" jsonb,
	"risk" text NOT NULL,
	"rule_id" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"taint" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	"edited" boolean DEFAULT false NOT NULL,
	"executed_at" timestamp with time zone,
	"execution_result" jsonb,
	"external_approval_id" uuid,
	"tool_use_id" text NOT NULL,
	"step_seq" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"domain" text DEFAULT '' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"service_token_enc" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "untrusted_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"step_seq" integer,
	"tool" text NOT NULL,
	"path" text NOT NULL,
	"text_hash" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_credentials" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"token_enc" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_credentials_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_eval_run_id_eval_runs_id_fk" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_batches" ADD CONSTRAINT "proposal_batches_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_batch_id_proposal_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."proposal_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "untrusted_spans" ADD CONSTRAINT "untrusted_spans_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_messages_run_seq_uq" ON "agent_messages" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "agent_runs_tenant_created_idx" ON "agent_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_status_lease_idx" ON "agent_runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "agent_runs_playbook_idx" ON "agent_runs" USING btree ("playbook_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_steps_run_seq_uq" ON "agent_steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "agent_steps_tool_use_idx" ON "agent_steps" USING btree ("run_id","tool_use_id");--> statement-breakpoint
CREATE INDEX "eval_results_run_idx" ON "eval_results" USING btree ("eval_run_id");--> statement-breakpoint
CREATE INDEX "interventions_run_idx" ON "interventions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "playbooks_tenant_idx" ON "playbooks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "proposal_batches_status_idx" ON "proposal_batches" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "proposal_batches_run_idx" ON "proposal_batches" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_run_tool_use_uq" ON "proposals" USING btree ("run_id","tool_use_id");--> statement-breakpoint
CREATE INDEX "proposals_tenant_status_idx" ON "proposals" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "proposals_batch_idx" ON "proposals" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "untrusted_spans_uq" ON "untrusted_spans" USING btree ("run_id","text_hash","path");
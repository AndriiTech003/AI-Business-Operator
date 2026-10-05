CREATE TABLE "workflow_calls" (
	"tenant_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"task" text NOT NULL,
	"run_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"response" jsonb,
	"workflow_id" text,
	"workflow_run_id" text,
	"node_id" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_calls_tenant_id_idempotency_key_pk" PRIMARY KEY("tenant_id","idempotency_key")
);
--> statement-breakpoint
CREATE INDEX "workflow_calls_run_idx" ON "workflow_calls" USING btree ("run_id");
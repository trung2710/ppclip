ALTER TABLE "cost_events" ALTER COLUMN "cost_cents" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ALTER COLUMN "total_cost_cents" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "budget_monthly_cents" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "spent_monthly_cents" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "budget_monthly_cents" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "spent_monthly_cents" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "status_card_updates" ALTER COLUMN "cost_cents" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "finance_events" ALTER COLUMN "amount_cents" SET DATA TYPE double precision;

-- Drop the standalone Webhook + WebhookDelivery infrastructure. Outbound HTTP
-- calls are now configured inline on each rule as the "Trigger a webhook"
-- action and dispatched synchronously when the rule fires.
DROP TABLE IF EXISTS "WebhookDelivery";
DROP TABLE IF EXISTS "Webhook";

-- AutoReadRule keeps inline webhook configs as a JSON array referenced by
-- actions of the form "webhook_call:<index>".
ALTER TABLE "AutoReadRule" ADD COLUMN "webhookConfigs" TEXT;

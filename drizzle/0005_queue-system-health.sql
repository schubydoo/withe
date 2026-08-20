ALTER TABLE `source` ADD `queue_depth` integer;--> statement-breakpoint
ALTER TABLE `source` ADD `oldest_queued_at` integer;--> statement-breakpoint
ALTER TABLE `source` ADD `oldest_queued_repo` text;--> statement-breakpoint
ALTER TABLE `source` ADD `runner_version` text;--> statement-breakpoint
ALTER TABLE `source` ADD `booted_at` integer;
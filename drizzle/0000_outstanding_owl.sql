CREATE TABLE `renovate_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_adapter_id` text NOT NULL,
	`repo_id` integer NOT NULL,
	`external_job_id` text NOT NULL,
	`reason` text,
	`queued_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`status` text NOT NULL,
	`error` text,
	`artifact_errors` text,
	`log_location` text,
	`runner_version` text,
	FOREIGN KEY (`source_adapter_id`) REFERENCES `source`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_source_ext` ON `renovate_run` (`source_adapter_id`,`external_job_id`);--> statement-breakpoint
CREATE INDEX `run_repo_completed` ON `renovate_run` (`repo_id`,`completed_at`);--> statement-breakpoint
CREATE TABLE `repo` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_adapter_id` text NOT NULL,
	`org` text NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`enabled` integer NOT NULL,
	`install_status` text,
	`queue_name` text,
	`installed_at` integer,
	`removed_at` integer,
	`stalled` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`source_adapter_id`) REFERENCES `source`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_source_full` ON `repo` (`source_adapter_id`,`full_name`);--> statement-breakpoint
CREATE TABLE `source` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`last_sync_at` integer,
	`last_sync_outcome` text
);
--> statement-breakpoint
CREATE TABLE `sync_status` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_adapter_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text NOT NULL,
	`error` text,
	`repo_count` integer,
	`run_count` integer,
	FOREIGN KEY (`source_adapter_id`) REFERENCES `source`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `update` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_adapter_id` text NOT NULL,
	`repo_id` integer NOT NULL,
	`dependency_name` text NOT NULL,
	`current_version` text,
	`target_version` text,
	`update_type` text,
	`state` text,
	`pr_url` text,
	`pr_number` integer,
	`closed_at` integer,
	`close_type` text,
	`detected_at` integer,
	`package_file_count` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`source_adapter_id`) REFERENCES `source`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `update_natural` ON `update` (`source_adapter_id`,`repo_id`,`dependency_name`,`current_version`,`target_version`,`update_type`);
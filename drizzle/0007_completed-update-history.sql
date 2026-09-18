CREATE TABLE `completed_update` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_adapter_id` text NOT NULL,
	`repo_id` integer NOT NULL,
	`dependency_name` text NOT NULL,
	`current_version` text,
	`target_version` text,
	`update_type` text,
	`datasource` text,
	`package_name` text,
	`final_state` text NOT NULL,
	`pr_url` text,
	`pr_number` integer NOT NULL,
	`closed_at` integer,
	`archived_at` integer NOT NULL,
	FOREIGN KEY (`source_adapter_id`) REFERENCES `source`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `completed_natural` ON `completed_update` (`source_adapter_id`,`repo_id`,`dependency_name`,`current_version`,`target_version`,`update_type`,`pr_number`);--> statement-breakpoint
CREATE INDEX `completed_repo_closed` ON `completed_update` (`repo_id`,`closed_at`);
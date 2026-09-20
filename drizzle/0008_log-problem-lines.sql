CREATE TABLE `log_problem` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_adapter_id` text NOT NULL,
	`run_id` integer NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`at` integer,
	`occurrences` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`source_adapter_id`) REFERENCES `source`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `renovate_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `problem_run` ON `log_problem` (`run_id`);--> statement-breakpoint
CREATE INDEX `problem_level` ON `log_problem` (`level`);
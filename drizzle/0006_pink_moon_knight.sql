CREATE TABLE `forge_rate_limit` (
	`id` integer PRIMARY KEY NOT NULL,
	`remaining` integer NOT NULL,
	`limit` integer NOT NULL,
	`reset_at` integer,
	`checked_at` integer NOT NULL
);

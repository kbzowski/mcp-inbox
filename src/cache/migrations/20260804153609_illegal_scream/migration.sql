CREATE TABLE `vec_index_state` (
	`folder` text PRIMARY KEY,
	`model` text NOT NULL,
	`dims` integer NOT NULL,
	`from_uid` integer NOT NULL,
	`to_uid` integer NOT NULL,
	`indexed_at` integer NOT NULL
);

import { pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const taskTransitions = pgTable("task_transitions", {
	fromStatus: text("from_status").notNull(), toStatus: text("to_status").notNull(),
}, (t) => [primaryKey({ columns: [t.fromStatus, t.toStatus] })]);

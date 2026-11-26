import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  json,
  uniqueIndex,
  index,
  numeric,
  customType,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────────────────────
// organisations
// ─────────────────────────────────────────────────────────────────────────────
export const organisations = pgTable('organisations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseCurrency: text('base_currency').notNull().default('INR'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// users
// ─────────────────────────────────────────────────────────────────────────────
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['employee', 'manager', 'admin'] })
      .notNull()
      .default('employee'),
    // Self-referential FK — arrow form avoids circular reference at module load time
    managerId: text('manager_id').references(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): any => users.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

// ─────────────────────────────────────────────────────────────────────────────
// mcp_tokens
// ─────────────────────────────────────────────────────────────────────────────
export const mcpTokens = pgTable(
  'mcp_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    label: text('label').notNull().default('Default'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('mcp_tokens_hash_idx').on(t.tokenHash)],
);

// ─────────────────────────────────────────────────────────────────────────────
// policy  (one row per org)
// ─────────────────────────────────────────────────────────────────────────────
export const policy = pgTable('policy', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => organisations.id, { onDelete: 'cascade' }),
  receiptRequiredAboveMinor: integer('receipt_required_above_minor').notNull().default(50000), // ₹500
  gstinRequiredAboveMinor: integer('gstin_required_above_minor').notNull().default(200000), // ₹2,000
  allowWeekendSpend: boolean('allow_weekend_spend').notNull().default(false),
  notes: text('notes').notNull().default(''),
});

// ─────────────────────────────────────────────────────────────────────────────
// categories
// ─────────────────────────────────────────────────────────────────────────────
export const categories = pgTable(
  'categories',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: text('code').notNull(),
    perItemLimitMinor: integer('per_item_limit_minor'), // null = no limit
    perDayLimitMinor: integer('per_day_limit_minor'),  // null = no limit
    active: boolean('active').notNull().default(true),
  },
  (t) => [
    index('categories_org_idx').on(t.orgId),
    uniqueIndex('categories_org_code_idx').on(t.orgId, t.code),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// claims
// ─────────────────────────────────────────────────────────────────────────────
export const claims = pgTable(
  'claims',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    purpose: text('purpose').notNull().default(''),
    tripStart: text('trip_start'), // ISO date string YYYY-MM-DD
    tripEnd: text('trip_end'),
    status: text('status', {
      enum: ['draft', 'submitted', 'approved', 'partially_approved', 'rejected', 'paid'],
    })
      .notNull()
      .default('draft'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by').references(() => users.id),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    source: text('source', { enum: ['claude', 'web'] }).notNull().default('web'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('claims_org_idx').on(t.orgId),
    index('claims_user_idx').on(t.userId),
    index('claims_status_idx').on(t.status),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// expenses
// ─────────────────────────────────────────────────────────────────────────────
export const expenses = pgTable(
  'expenses',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),
    date: text('date').notNull(), // ISO date YYYY-MM-DD
    merchant: text('merchant').notNull(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    description: text('description').notNull().default(''),
    amountMinor: integer('amount_minor').notNull(), // paise, never float
    currency: text('currency').notNull().default('INR'),
    fxRate: numeric('fx_rate', { precision: 10, scale: 6 }), // null for INR
    gstin: text('gstin'),
    taxableMinor: integer('taxable_minor').notNull().default(0),
    cgstMinor: integer('cgst_minor').notNull().default(0),
    sgstMinor: integer('sgst_minor').notNull().default(0),
    igstMinor: integer('igst_minor').notNull().default(0),
    paymentMethod: text('payment_method', {
      enum: ['personal_card', 'cash', 'upi', 'company_card'],
    })
      .notNull()
      .default('personal_card'),
    receiptUrl: text('receipt_url'),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    reviewerNote: text('reviewer_note'),
    flags: json('flags').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('expenses_claim_idx').on(t.claimId)],
);

// ─────────────────────────────────────────────────────────────────────────────
// comments
// ─────────────────────────────────────────────────────────────────────────────
export const comments = pgTable(
  'comments',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('comments_claim_idx').on(t.claimId)],
);

// ─────────────────────────────────────────────────────────────────────────────
// audit_log
// ─────────────────────────────────────────────────────────────────────────────
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorVia: text('actor_via', { enum: ['web', 'mcp'] }).notNull(),
    entity: text('entity').notNull(),   // e.g. 'claim', 'expense'
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),   // e.g. 'create', 'update', 'submit', 'approve'
    before: json('before').$type<Record<string, unknown> | null>(),
    after: json('after').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_org_idx').on(t.orgId),
    index('audit_log_entity_idx').on(t.entity, t.entityId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// receipt_files  (receipt bytes stored in Postgres — the default storage backend,
// so a demo deployment needs nothing but one database)
// ─────────────────────────────────────────────────────────────────────────────
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const receiptFiles = pgTable('receipt_files', {
  name: text('name').primaryKey(), // <uuid>.<ext>, same as in expenses.receipt_url
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  data: bytea('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// assistant_events  (one row per voice/text assistant turn; text is stored
// REDACTED only — never the raw utterance. Feeds the weekly pulse.)
// ─────────────────────────────────────────────────────────────────────────────
export const assistantEvents = pgTable(
  'assistant_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    channel: text('channel', { enum: ['voice', 'text'] }).notNull(),
    intent: text('intent').notNull(),
    // needs_info | previewed | confirmed | cancelled | answered | queued | not_covered | refused | error
    outcome: text('outcome').notNull(),
    textRedacted: text('text_redacted').notNull(),
    piiFound: json('pii_found').$type<string[]>().notNull().default([]),
    meta: json('meta').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('assistant_events_org_created_idx').on(t.orgId, t.createdAt)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Weekly loop: runs, the actions awaiting approval, what was written, and the
// approved canonical answers the assistant reuses. No PII: texts are redacted
// before they are stored, and recipients are roles, never email addresses.
// ─────────────────────────────────────────────────────────────────────────────
export const weeklyRuns = pgTable(
  'weekly_runs',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    windowStart: text('window_start').notNull(), // YYYY-MM-DD, inclusive
    windowEnd: text('window_end').notNull(), // YYYY-MM-DD, inclusive
    trigger: text('trigger', { enum: ['manual', 'schedule'] }).notNull(),
    themes: json('themes').$type<unknown[]>().notNull(),
    stats: json('stats').$type<Record<string, unknown>>().notNull(),
    pulse: json('pulse').$type<Record<string, unknown>>().notNull(),
    explainer: json('explainer').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('weekly_runs_org_idx').on(t.orgId, t.createdAt)],
);

export const runActions = pgTable(
  'run_actions',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => weeklyRuns.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['append_doc', 'email_draft', 'publish_explainer'] }).notNull(),
    /** Human-readable destination, shown on the approval screen. */
    target: text('target').notNull(),
    /** The exact content that will be written if approved. */
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
    edited: boolean('edited').notNull().default(false),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('run_actions_run_idx').on(t.runId)],
);

export const publishedOutputs = pgTable(
  'published_outputs',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    actionId: text('action_id')
      .notNull()
      .references(() => runActions.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['doc_entry', 'email_draft'] }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    meta: json('meta').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('published_outputs_action_idx').on(t.actionId)],
);

export const canonicalAnswers = pgTable(
  'canonical_answers',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    /** Corpus passage id this answer covers (the retrieval topic). */
    topic: text('topic').notNull(),
    title: text('title').notNull(),
    bullets: json('bullets').$type<{ text: string; passageId: string }[]>().notNull(),
    sources: json('sources').$type<{ title: string; url: string; lastChecked: string }[]>().notNull(),
    lastChecked: text('last_checked').notNull(),
    actionId: text('action_id').references(() => runActions.id, { onDelete: 'set null' }),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
    active: boolean('active').notNull().default(true),
    timesReused: integer('times_reused').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('canonical_answers_org_topic_idx').on(t.orgId, t.topic)],
);

// ─────────────────────────────────────────────────────────────────────────────
// reply_drafts  (the response desk's queue). Every policy question that is not
// refused and has no approved canonical answer becomes one row: the draft the
// orchestrator assembled from the three agents, the reviewer's verdict and the
// routing note. Nothing reaches the employee until a person approves the row.
// Question and reply text are stored REDACTED only.
// ─────────────────────────────────────────────────────────────────────────────
export const replyDrafts = pgTable(
  'reply_drafts',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    /** Who asked: the approved reply is shown back to them. Never shown in the queue. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    via: text('via', { enum: ['web', 'mcp'] }).notNull(),
    channel: text('channel', { enum: ['voice', 'text'] }).notNull(),
    question: text('question').notNull(),
    topic: text('topic').notNull(),
    covered: boolean('covered').notNull(),
    drafter: text('drafter', { enum: ['model', 'extractive', 'none'] }).notNull(),
    /** The orchestrator's draft, exactly as the reviewer checked it. */
    draft: text('draft').notNull(),
    sources: json('sources')
      .$type<{ title: string; url: string; lastChecked: string; passageId: string }[]>()
      .notNull(),
    searched: json('searched').$type<string[]>().notNull(),
    /** Orchestrator output: where this goes and why. */
    routing: json('routing').$type<Record<string, unknown>>().notNull(),
    /** Reviewer output: verdict (pass | flag | reject) and flags. */
    review: json('review').$type<Record<string, unknown>>().notNull(),
    /** What each of the three agents returned, and how long it took. */
    agents: json('agents').$type<Record<string, unknown>[]>().notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
    edited: boolean('edited').notNull().default(false),
    /** The text the employee sees once approved (the draft, or the human edit). */
    finalReply: text('final_reply'),
    rejectReason: text('reject_reason'),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reply_drafts_org_status_idx').on(t.orgId, t.status, t.createdAt),
    index('reply_drafts_user_idx').on(t.userId, t.createdAt),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Relations (for Drizzle query API)
// ─────────────────────────────────────────────────────────────────────────────
export const organisationsRelations = relations(organisations, ({ many, one }) => ({
  users: many(users),
  categories: many(categories),
  claims: many(claims),
  policy: one(policy, { fields: [organisations.id], references: [policy.orgId] }),
  auditLog: many(auditLog),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  organisation: one(organisations, { fields: [users.orgId], references: [organisations.id] }),
  manager: one(users, { fields: [users.managerId], references: [users.id], relationName: 'reports' }),
  reports: many(users, { relationName: 'reports' }),
  claims: many(claims),
  mcpTokens: many(mcpTokens),
  comments: many(comments),
}));

export const claimsRelations = relations(claims, ({ one, many }) => ({
  organisation: one(organisations, { fields: [claims.orgId], references: [organisations.id] }),
  user: one(users, { fields: [claims.userId], references: [users.id] }),
  decidedByUser: one(users, { fields: [claims.decidedBy], references: [users.id] }),
  expenses: many(expenses),
  comments: many(comments),
}));

export const expensesRelations = relations(expenses, ({ one }) => ({
  claim: one(claims, { fields: [expenses.claimId], references: [claims.id] }),
  category: one(categories, { fields: [expenses.categoryId], references: [categories.id] }),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  organisation: one(organisations, { fields: [categories.orgId], references: [organisations.id] }),
  expenses: many(expenses),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  claim: one(claims, { fields: [comments.claimId], references: [claims.id] }),
  user: one(users, { fields: [comments.userId], references: [users.id] }),
}));

export const mcpTokensRelations = relations(mcpTokens, ({ one }) => ({
  user: one(users, { fields: [mcpTokens.userId], references: [users.id] }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  organisation: one(organisations, { fields: [auditLog.orgId], references: [organisations.id] }),
  actor: one(users, { fields: [auditLog.actorUserId], references: [users.id] }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Inferred TypeScript types
// ─────────────────────────────────────────────────────────────────────────────
export type Organisation = typeof organisations.$inferSelect;
export type NewOrganisation = typeof organisations.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserRole = 'employee' | 'manager' | 'admin';

export type McpToken = typeof mcpTokens.$inferSelect;
export type NewMcpToken = typeof mcpTokens.$inferInsert;

export type Policy = typeof policy.$inferSelect;
export type NewPolicy = typeof policy.$inferInsert;

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;

export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;
export type ClaimStatus = 'draft' | 'submitted' | 'approved' | 'partially_approved' | 'rejected' | 'paid';
export type ClaimSource = 'claude' | 'web';

export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
export type ExpenseStatus = 'pending' | 'approved' | 'rejected';
export type PaymentMethod = 'personal_card' | 'cash' | 'upi' | 'company_card';

export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
export type AuditVia = 'web' | 'mcp';

export type ReceiptFile = typeof receiptFiles.$inferSelect;

export type AssistantEvent = typeof assistantEvents.$inferSelect;
export type NewAssistantEvent = typeof assistantEvents.$inferInsert;
export type WeeklyRun = typeof weeklyRuns.$inferSelect;
export type RunAction = typeof runActions.$inferSelect;
export type PublishedOutput = typeof publishedOutputs.$inferSelect;
export type CanonicalAnswer = typeof canonicalAnswers.$inferSelect;
export type ReplyDraft = typeof replyDrafts.$inferSelect;

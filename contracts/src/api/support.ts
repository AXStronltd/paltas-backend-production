// PALTAS Support chat. A signed-in client talks to PALTAS from any workspace: the PALTAS assistant (AI) answers at
// any hour from PALTAS help and the client's own account facts, and hands the conversation to the PALTAS team when a
// person should answer (or the client asks). The team sees every conversation in the Super Admin portal and replies
// as themselves. Every message says who wrote it: the client, "PALTAS assistant" or a named staff member.
import { z } from "zod";
import { IsoDateTime, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";

export const SupportAuthor = z.enum(["client", "assistant", "staff", "system"]);
export const MessageText = z.string().trim().min(1, "Write a message").max(4000, "Keep it under 4,000 characters");

export const SupportMessage = z.object({
  id: z.string(),
  author: SupportAuthor,
  /** "PALTAS assistant", the staff member's name, or the client's name. */
  authorName: z.string(),
  body: z.string(),
  /** Staff only: a note for the PALTAS team, never shown to the client. */
  internal: z.boolean(),
  at: IsoDateTime,
});
export type SupportMessage = z.infer<typeof SupportMessage>;

export const SupportConversation = z.object({
  id: z.string(),
  subject: z.string(),
  orgId: z.string().nullable(),
  orgName: z.string().nullable(),
  status: z.enum(["open", "closed"]),
  /** Waiting for a person from PALTAS. */
  needsHuman: z.boolean(),
  lastMessageAt: IsoDateTime,
  lastAuthor: SupportAuthor,
  /** Messages the reader has not seen yet (for the client: from PALTAS; for staff: from the client). */
  unread: z.number().int(),
  createdAt: IsoDateTime,
});

export const SupportThread = z.object({
  conversation: SupportConversation,
  messages: z.array(SupportMessage),
  /** Whether the PALTAS assistant answers new messages right now (false: a person will reply). */
  assistantActive: z.boolean(),
});
export type SupportThread = z.infer<typeof SupportThread>;

const ConversationParams = z.object({ conversationId: z.string().min(1) });

// ------------------------------------------------------------------ the client
export const listConversations = endpoint({
  id: "support.list",
  method: "GET",
  path: "/api/v1/support/conversations",
  auth: "user",
  summary: "My conversations with PALTAS Support, newest first",
  response: z.object({ conversations: z.array(SupportConversation) }),
});

export const startConversation = endpoint({
  id: "support.start",
  method: "POST",
  path: "/api/v1/support/conversations",
  auth: "user",
  summary:
    "Start a conversation with PALTAS Support. The PALTAS assistant answers at once (or the PALTAS team, when a person " +
    "should). orgId: the company it is about (one you belong to), so the answer can use its plan, trial and invoices.",
  body: z.object({ orgId: z.string().min(1).optional(), message: MessageText, person: z.boolean().default(false) }),
  response: SupportThread,
  status: 201,
});

export const getConversation = endpoint({
  id: "support.get",
  method: "GET",
  path: "/api/v1/support/conversations/:conversationId",
  auth: "user",
  summary: "One of my conversations in full (marks the replies as read)",
  params: ConversationParams,
  response: SupportThread,
});

export const sendMessage = endpoint({
  id: "support.send",
  method: "POST",
  path: "/api/v1/support/conversations/:conversationId/messages",
  auth: "user",
  summary:
    "Write in my conversation. person: true asks for a person from PALTAS (the assistant stops answering). A closed " +
    "conversation opens again.",
  params: ConversationParams,
  body: z.object({ message: MessageText, person: z.boolean().default(false) }),
  response: SupportThread,
});

// ------------------------------------------------------------------ the PALTAS team (Super Admin portal)
export const InboxRow = SupportConversation.extend({
  client: z.object({ userId: z.string(), name: z.string(), email: z.string() }),
  assignedTo: z.object({ userId: z.string(), name: z.string() }).nullable(),
  lastMessage: z.string(),
});

export const supportInbox = endpoint({
  id: "admin.support.inbox",
  method: "GET",
  path: "/api/v1/admin/support",
  auth: "staff",
  summary: "Every client conversation: waiting for a person first, then the newest",
  query: z.object({
    view: z.enum(["needs_person", "open", "mine", "closed", "all"]).default("needs_person"),
    q: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }),
  response: z.object({
    conversations: z.array(InboxRow),
    counts: z.object({ needsPerson: z.number().int(), open: z.number().int(), mine: z.number().int() }),
  }),
});

export const supportThread = endpoint({
  id: "admin.support.get",
  method: "GET",
  path: "/api/v1/admin/support/:conversationId",
  auth: "staff",
  summary: "One conversation in full, internal notes included (marks the client's messages as read by PALTAS)",
  params: ConversationParams,
  response: SupportThread.extend({ inbox: InboxRow }),
});

export const supportReply = endpoint({
  id: "admin.support.reply",
  method: "POST",
  path: "/api/v1/admin/support/:conversationId/messages",
  auth: "staff",
  summary:
    "Reply to the client as yourself (they see your name, and get an e-mail that PALTAS replied), or add an internal " +
    "note for the team. A reply takes the conversation off the 'needs a person' list and assigns it to you if nobody has it.",
  params: ConversationParams,
  body: z.object({ message: MessageText, internal: z.boolean().default(false) }),
  response: SupportThread,
});

export const supportUpdate = endpoint({
  id: "admin.support.update",
  method: "PUT",
  path: "/api/v1/admin/support/:conversationId",
  auth: "staff",
  summary:
    "Assign (userId of a staff member who may reply, or null), close or reopen, or hand the conversation back to the " +
    "PALTAS assistant (needsHuman: false).",
  params: ConversationParams,
  body: z
    .object({
      assignedTo: z.string().min(1).nullable().optional(),
      status: z.enum(["open", "closed"]).optional(),
      needsHuman: z.boolean().optional(),
      reason: Reason.optional(),
    })
    .refine(
      (b) => b.assignedTo !== undefined || b.status !== undefined || b.needsHuman !== undefined,
      "Choose what to change",
    ),
  response: z.object({ ok: z.literal(true) }),
});

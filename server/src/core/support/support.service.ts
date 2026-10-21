/*
 * PALTAS Support chat.
 *
 * Clients (any signed-in non-staff person) talk to PALTAS from their workspace. The PALTAS assistant answers at any
 * hour from PALTAS help and the client's OWN account facts (their companies, plans, trials, open invoices), and hands
 * the conversation to the PALTAS team when a person should answer — when it is unsure, for money disputes, account
 * changes or anything it cannot see, when the client asks for a person, when no AI key is configured, when the AI does
 * not answer, or after the daily assistant limit. From then on the assistant stays quiet until a staff member hands
 * the conversation back.
 *
 * The PALTAS team sees every conversation (internal notes included) in the Super Admin portal and replies as
 * themselves ("support.respond"); the client gets an e-mail that PALTAS replied. Every message names its author;
 * messages are never edited or deleted. The AI call happens outside any database transaction.
 */
import { STAFF_ROLE_DEFINITIONS, type StaffRole } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import { staffActor } from "../admin/admin.service.js";
import { recordAudit } from "../audit/audit.service.js";
import type { SessionUser } from "../identity/identity.service.js";
import type { NotificationsService } from "../notifications/notifications.service.js";
import { anthropicAssistant, toTurns, type SupportAssistant } from "./assistant.js";
import { assistantBrief } from "./knowledge.js";

type Author = "client" | "assistant" | "staff" | "system";
interface ConvRow {
  id: string;
  user_id: string;
  org_id: string | null;
  org_name: string | null;
  subject: string;
  status: "open" | "closed";
  needs_human: boolean;
  assigned_to: string | null;
  last_message_at: string;
  last_author: Author;
  client_read_at: string | null;
  staff_read_at: string | null;
  created_at: string;
}
interface MsgRow {
  id: string;
  author: Author;
  author_user_id: string | null;
  author_name: string | null;
  body: string;
  internal: boolean;
  created_at: string;
}

const ASSISTANT = "PALTAS assistant";
const TO_TEAM =
  "A person from the PALTAS team will reply here. You will also get an e-mail when they do, so you can close this window.";
const NO_ASSISTANT = "Thank you — the PALTAS team has your message and will reply here. You will also get an e-mail.";
const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());

export function supportService(ctx: AppContext, deps: { notifications: NotificationsService }) {
  const { db, config, clock } = ctx;
  const assistant: SupportAssistant | null =
    ctx.supportAssistant !== undefined ? ctx.supportAssistant : anthropicAssistant(config.supportAi, ctx.log);

  const CONV_SQL = `SELECT c.*, o.name AS org_name FROM support_conversations c LEFT JOIN organisations o ON o.id = c.org_id`;

  async function conv(t: Db, id: string, lock = false) {
    const r = await t.row<ConvRow>(`${CONV_SQL} WHERE c.id = $1${lock ? " FOR UPDATE OF c" : ""}`, [id]);
    if (!r) throw fail.notFound("Conversation not found");
    return r;
  }
  async function own(t: Db, user: SessionUser, id: string, lock = false) {
    if (user.staffRole)
      throw fail.forbidden("PALTAS staff answer clients in the Support inbox of the Super Admin portal");
    const c = await conv(t, id, lock);
    if (c.user_id !== user.id) throw fail.notFound("Conversation not found");
    return c;
  }

  async function messages(t: Db, id: string, staff: boolean) {
    const rows = await t.rows<MsgRow>(
      `SELECT m.id::text, m.author, m.author_user_id, u.name AS author_name, m.body, m.internal, m.created_at
       FROM support_messages m LEFT JOIN users u ON u.id = m.author_user_id
       WHERE m.conversation_id = $1 ${staff ? "" : "AND NOT m.internal"} ORDER BY m.id`,
      [id],
    );
    return rows.map((m) => ({
      id: m.id,
      author: m.author,
      authorName:
        m.author === "assistant"
          ? ASSISTANT
          : m.author === "system"
            ? "PALTAS"
            : m.author === "staff"
              ? `${m.author_name ?? "PALTAS"} · PALTAS team`
              : (m.author_name ?? "You"),
      body: m.body,
      internal: m.internal,
      at: iso(m.created_at) as string,
    }));
  }

  async function unread(t: Db, c: ConvRow, viewer: "client" | "staff") {
    const since = viewer === "client" ? c.client_read_at : c.staff_read_at;
    const authors = viewer === "client" ? ["assistant", "staff", "system"] : ["client"];
    const r = await t.row<{ n: number }>(
      `SELECT count(*)::int AS n FROM support_messages WHERE conversation_id = $1 AND author = ANY($2) AND NOT internal
         AND ($3::timestamptz IS NULL OR created_at > $3)`,
      [c.id, authors, since],
    );
    return r?.n ?? 0;
  }

  async function view(t: Db, c: ConvRow, viewer: "client" | "staff") {
    return {
      id: c.id,
      subject: c.subject,
      orgId: c.org_id,
      orgName: c.org_name,
      status: c.status,
      needsHuman: c.needs_human,
      lastMessageAt: iso(c.last_message_at) as string,
      lastAuthor: c.last_author,
      unread: await unread(t, c, viewer),
      createdAt: iso(c.created_at) as string,
    };
  }

  async function thread(t: Db, id: string, viewer: "client" | "staff") {
    const c = await conv(t, id);
    return {
      conversation: await view(t, c, viewer),
      messages: await messages(t, id, viewer === "staff"),
      assistantActive: !!assistant && !c.needs_human && c.status === "open",
    };
  }

  async function add(
    t: Db,
    c: { id: string },
    m: { author: Author; userId?: string | null; body: string; internal?: boolean; model?: string | null },
  ) {
    const r = await t.row<{ id: string }>(
      `INSERT INTO support_messages (conversation_id, author, author_user_id, body, internal, ai_model)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
      [c.id, m.author, m.userId ?? null, m.body.slice(0, 4000), !!m.internal, m.model ?? null],
    );
    if (!m.internal)
      await t.run("UPDATE support_conversations SET last_message_at = now(), last_author = $2 WHERE id = $1", [
        c.id,
        m.author,
      ]);
    return r?.id as string;
  }

  /** Hand the conversation to the PALTAS team (once: the notice is not repeated). */
  async function toTeam(t: Db, id: string, text: string) {
    const c = await conv(t, id, true);
    if (c.needs_human) return;
    await t.run("UPDATE support_conversations SET needs_human = true WHERE id = $1", [id]);
    await add(t, c, { author: "system", body: text });
  }

  /** What the assistant knows about this client: only their own records. */
  async function accountFacts(c: ConvRow) {
    const u = await db.row<{ name: string; email: string; verified: boolean; two_factor: boolean }>(
      `SELECT name, email, (email_verified_at IS NOT NULL) AS verified, (mfa_secret_sealed IS NOT NULL) AS two_factor
       FROM users WHERE id = $1`,
      [c.user_id],
    );
    const orgs = await db.rows<{ id: string; name: string; role: string; status: string; suspended: boolean }>(
      `SELECT o.id, o.name, m.role, m.status, (o.suspended_at IS NOT NULL) AS suspended FROM memberships m
       JOIN organisations o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.name`,
      [c.user_id],
    );
    const focus = c.org_id ?? (orgs.length === 1 ? (orgs[0]?.id ?? null) : null);
    const subs = focus
      ? await db.rows<{ product: string; plan_id: string | null; status: string; trial_ends: string | null }>(
          "SELECT product, plan_id, status, trial_ends FROM subscriptions WHERE org_id = $1 ORDER BY created_at",
          [focus],
        )
      : [];
    const invoices = focus
      ? await db.rows<{
          id: string;
          product: string;
          total_minor: number;
          currency: string;
          due: string;
          status: string;
        }>(
          `SELECT id, product, total_minor, currency, due, status FROM billing_invoices
           WHERE org_id = $1 AND status IN ('Open', 'Payment failed') ORDER BY due LIMIT 10`,
          [focus],
        )
      : [];
    const policy = await db.row<{ trial_days: number; grace_days: number; export_allowed: boolean }>(
      "SELECT trial_days, grace_days, export_allowed FROM trial_policy WHERE id = 1",
    );
    return { user: u, orgs, focus, subs, invoices, policy };
  }

  /** The assistant's turn after a client message (outside any transaction: the AI call may take seconds). */
  async function answer(id: string, userId: string) {
    const c = await conv(db, id);
    if (c.needs_human || c.status !== "open") return;
    if (!assistant) return db.tx((t) => toTeam(t, id, NO_ASSISTANT));
    const today = await db.row<{ n: number }>(
      `SELECT count(*)::int AS n FROM support_messages m JOIN support_conversations c ON c.id = m.conversation_id
       WHERE c.user_id = $1 AND m.author = 'assistant' AND m.created_at >= $2::date`,
      [userId, clock.today()],
    );
    if ((today?.n ?? 0) >= config.supportAi.dailyLimit) return db.tx((t) => toTeam(t, id, NO_ASSISTANT));
    const history = (await messages(db, id, false)).slice(-24);
    const reply = await assistant({
      system: assistantBrief(await accountFacts(c), clock.today()),
      turns: toTurns(history),
    });
    await db.tx(async (t) => {
      const now = await conv(t, id, true);
      if (now.needs_human || now.status !== "open") return; // a person took over meanwhile
      if (!reply) return toTeam(t, id, NO_ASSISTANT);
      if (reply.text) await add(t, now, { author: "assistant", body: reply.text, model: reply.model });
      if (reply.handover) await toTeam(t, id, TO_TEAM);
    });
  }

  async function memberOf(t: Db, userId: string, orgId: string) {
    const m = await t.row("SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2 AND status = 'active'", [
      userId,
      orgId,
    ]);
    if (!m) throw fail.notFound("Company not found");
  }

  function subjectOf(text: string) {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > 80 ? line.slice(0, 77).trimEnd() + "…" : line;
  }

  // ------------------------------------------------------------------ staff helpers
  async function inboxRows(t: Db, where: string, params: unknown[], limit: number) {
    const rows = await t.rows<
      ConvRow & {
        client_name: string;
        client_email: string;
        assignee_name: string | null;
        last_message: string | null;
      }
    >(
      `SELECT c.*, o.name AS org_name, u.name AS client_name, u.email AS client_email, a.name AS assignee_name,
         (SELECT m.body FROM support_messages m WHERE m.conversation_id = c.id AND NOT m.internal ORDER BY m.id DESC LIMIT 1)
           AS last_message
       FROM support_conversations c JOIN users u ON u.id = c.user_id LEFT JOIN users a ON a.id = c.assigned_to
       LEFT JOIN organisations o ON o.id = c.org_id
       WHERE ${where}
       ORDER BY (c.status = 'open' AND c.needs_human AND c.last_author IN ('client', 'system')) DESC, c.last_message_at DESC
       LIMIT ${limit}`,
      params,
    );
    const out = [];
    for (const r of rows)
      out.push({
        ...(await view(t, r, "staff")),
        client: { userId: r.user_id, name: r.client_name, email: r.client_email },
        assignedTo: r.assigned_to ? { userId: r.assigned_to, name: r.assignee_name ?? "" } : null,
        lastMessage: (r.last_message ?? "").slice(0, 200),
      });
    return out;
  }
  const WAITING = "c.status = 'open' AND c.needs_human AND c.last_author IN ('client', 'system')";

  return {
    // ---------------------------------------------------------------- the client
    async list(user: SessionUser) {
      if (user.staffRole)
        throw fail.forbidden("PALTAS staff answer clients in the Support inbox of the Super Admin portal");
      const rows = await db.rows<ConvRow>(
        `${CONV_SQL} WHERE c.user_id = $1 ORDER BY c.last_message_at DESC LIMIT 100`,
        [user.id],
      );
      const conversations = [];
      for (const r of rows) conversations.push(await view(db, r, "client"));
      return { conversations };
    },

    async start(user: SessionUser, b: { orgId?: string | undefined; message: string; person: boolean }) {
      if (user.staffRole)
        throw fail.forbidden("PALTAS staff answer clients in the Support inbox of the Super Admin portal");
      const id = newId("sup");
      await db.tx(async (t) => {
        if (b.orgId) await memberOf(t, user.id, b.orgId);
        await t.run("INSERT INTO support_conversations (id, user_id, org_id, subject) VALUES ($1, $2, $3, $4)", [
          id,
          user.id,
          b.orgId ?? null,
          subjectOf(b.message),
        ]);
        await add(t, { id }, { author: "client", userId: user.id, body: b.message });
        if (b.person) await toTeam(t, id, TO_TEAM);
      });
      await answer(id, user.id);
      return db.tx(async (t) => {
        await t.run("UPDATE support_conversations SET client_read_at = now() WHERE id = $1", [id]);
        return thread(t, id, "client");
      });
    },

    async get(user: SessionUser, id: string) {
      return db.tx(async (t) => {
        await own(t, user, id);
        await t.run("UPDATE support_conversations SET client_read_at = now() WHERE id = $1", [id]);
        return thread(t, id, "client");
      });
    },

    async send(user: SessionUser, id: string, b: { message: string; person: boolean }) {
      await db.tx(async (t) => {
        const c = await own(t, user, id, true);
        if (c.status === "closed") await t.run("UPDATE support_conversations SET status = 'open' WHERE id = $1", [id]);
        await add(t, c, { author: "client", userId: user.id, body: b.message });
        if (b.person) await toTeam(t, id, TO_TEAM);
      });
      await answer(id, user.id);
      return db.tx(async (t) => {
        await t.run("UPDATE support_conversations SET client_read_at = now() WHERE id = $1", [id]);
        return thread(t, id, "client");
      });
    },

    // ---------------------------------------------------------------- the PALTAS team
    async inbox(
      user: SessionUser,
      q: { view: "needs_person" | "open" | "mine" | "closed" | "all"; q?: string | undefined; limit: number },
    ) {
      staffActor(user);
      const where = {
        needs_person: WAITING,
        open: "c.status = 'open'",
        mine: "c.status = 'open' AND c.assigned_to = $1",
        closed: "c.status = 'closed'",
        all: "true",
      }[q.view];
      const params: unknown[] = [user.id];
      let filter = `(${where})`;
      if (q.q) {
        params.push("%" + q.q.toLowerCase().replace(/[\\%_]/g, (x) => "\\" + x) + "%");
        filter += ` AND (lower(c.subject) LIKE $2 OR lower(u.email) LIKE $2 OR lower(u.name) LIKE $2 OR lower(coalesce(o.name, '')) LIKE $2)`;
      }
      if (!filter.includes("$1")) filter += " AND $1::text IS NOT NULL";
      return db.tx(async (t) => {
        const conversations = await inboxRows(t, filter, params, q.limit);
        const counts = await t.row<{ waiting: number; open: number; mine: number }>(
          `SELECT count(*) FILTER (WHERE ${WAITING})::int AS waiting, count(*) FILTER (WHERE c.status = 'open')::int AS open,
                  count(*) FILTER (WHERE c.status = 'open' AND c.assigned_to = $1)::int AS mine
           FROM support_conversations c`,
          [user.id],
        );
        return {
          conversations,
          counts: { needsPerson: counts?.waiting ?? 0, open: counts?.open ?? 0, mine: counts?.mine ?? 0 },
        };
      });
    },

    async staffThread(user: SessionUser, id: string) {
      staffActor(user);
      return db.tx(async (t) => {
        await conv(t, id);
        await t.run("UPDATE support_conversations SET staff_read_at = now() WHERE id = $1", [id]);
        const [inbox] = await inboxRows(t, "c.id = $1", [id], 1);
        if (!inbox) throw fail.notFound("Conversation not found");
        return { ...(await thread(t, id, "staff")), inbox };
      });
    },

    async reply(user: SessionUser, id: string, b: { message: string; internal: boolean }) {
      staffActor(user, "support.respond");
      return db.tx(async (t) => {
        const c = await conv(t, id, true);
        const msgId = await add(t, c, { author: "staff", userId: user.id, body: b.message, internal: b.internal });
        if (!b.internal) {
          // a person is now in the conversation: the assistant stays quiet until someone hands it back
          await t.run(
            `UPDATE support_conversations SET needs_human = true, status = 'open', staff_read_at = now(),
               assigned_to = COALESCE(assigned_to, $2) WHERE id = $1`,
            [id, user.id],
          );
          const client = await t.row<{ name: string; email: string }>("SELECT name, email FROM users WHERE id = $1", [
            c.user_id,
          ]);
          if (c.org_id && client)
            await deps.notifications.record(t, {
              orgId: c.org_id,
              channel: "email",
              to: client.email,
              category: "transactional",
              templateKey: "support.reply",
              vars: {
                name: client.name,
                staffName: user.name,
                subject: c.subject,
                excerpt: b.message.length > 400 ? b.message.slice(0, 397) + "…" : b.message,
                link: `${config.signup.appBaseUrl}/account.html?support=${encodeURIComponent(id)}#account`,
              },
              source: "platform",
              sourceRef: "support.reply:" + msgId,
              createdBy: user.id,
            });
        }
        return thread(t, id, "staff");
      });
    },

    async update(
      user: SessionUser,
      id: string,
      b: {
        assignedTo?: string | null | undefined;
        status?: "open" | "closed" | undefined;
        needsHuman?: boolean | undefined;
        reason?: string | undefined;
      },
    ) {
      const actor = staffActor(user, "support.respond");
      return db.tx(async (t) => {
        const c = await conv(t, id, true);
        const changes: string[] = [];
        if (b.assignedTo !== undefined && b.assignedTo !== c.assigned_to) {
          if (b.assignedTo) {
            const s = await t.row<{ name: string; staff_role: StaffRole | null; active: boolean }>(
              "SELECT name, staff_role, active FROM users WHERE id = $1",
              [b.assignedTo],
            );
            if (
              !s?.staff_role ||
              !s.active ||
              !STAFF_ROLE_DEFINITIONS[s.staff_role].permissions.includes("support.respond")
            )
              throw fail.invalid("Assign the conversation to an active staff member who can answer clients");
            changes.push("assigned to " + s.name);
          } else changes.push("unassigned");
          await t.run("UPDATE support_conversations SET assigned_to = $2 WHERE id = $1", [id, b.assignedTo]);
        }
        if (b.status && b.status !== c.status) {
          await t.run("UPDATE support_conversations SET status = $2 WHERE id = $1", [id, b.status]);
          await add(t, c, {
            author: "system",
            body:
              b.status === "closed"
                ? "PALTAS closed this conversation. Write here any time to open it again."
                : "PALTAS opened this conversation again.",
          });
          changes.push(b.status === "closed" ? "closed" : "reopened");
        }
        if (b.needsHuman !== undefined && b.needsHuman !== c.needs_human) {
          await t.run("UPDATE support_conversations SET needs_human = $2 WHERE id = $1", [id, b.needsHuman]);
          if (!b.needsHuman && assistant)
            await add(t, c, { author: "system", body: "The PALTAS assistant answers new messages here again." });
          changes.push(b.needsHuman ? "taken over by the team" : "handed back to the assistant");
        }
        if (changes.length)
          await recordAudit(t, {
            actor,
            orgId: c.org_id,
            action: "Support conversation changed",
            target: id,
            detail: changes.join(", ") + (b.reason ? " · " + b.reason : ""),
          });
        return { ok: true as const };
      });
    },
  };
}
export type SupportService = ReturnType<typeof supportService>;

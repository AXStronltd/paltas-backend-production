// PALTAS Support chat:
// - a client starts a conversation; the assistant answers from PALTAS help and ONLY that client's account facts;
// - the assistant hands over ([[HANDOVER]]), the client asks for a person, no key / no answer / daily limit → the
//   PALTAS team gets it, and the assistant stays quiet until a staff member hands it back;
// - the team sees every conversation (internal notes only for them), replies as themselves (the client is e-mailed),
//   assigns and closes; only staff who may answer clients can reply; clients only ever see their own conversations.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupportAssistant } from "../dist/core/support/assistant.js";
import { staffMember } from "./support/platform-fixtures.js";
import { refused, startServer, type TestServer } from "./support/test-server.js";

describe("support chat with the assistant", () => {
  let S: TestServer;
  let A: Awaited<ReturnType<TestServer["newOrg"]>>;
  let B: Awaited<ReturnType<TestServer["newOrg"]>>;
  const seen: { system: string; turns: { role: string; content: string }[] }[] = [];
  let next: (input: { system: string }) => string | null = () => "Go to Account → Your team and press Invite.";
  const fake: SupportAssistant = async (input) => {
    seen.push(input);
    const raw = next(input);
    return raw === null
      ? null
      : { text: raw.replace("[[HANDOVER]]", "").trim(), handover: raw.includes("[[HANDOVER]]"), model: "test-model" };
  };
  beforeAll(async () => {
    S = await startServer({
      supportAssistant: fake,
      config: { supportAi: { apiKey: undefined, model: "test-model", dailyLimit: 3 } },
    });
    A = await S.newOrg({ name: "Alpha Homes" });
    B = await S.newOrg({ name: "Bravo Homes" });
  });
  afterAll(() => S.close());

  it("answers at once, from this client's own facts only", async () => {
    const t = await A.admin.api.support.start({ body: { orgId: A.orgId, message: "How do I invite my colleague?" } });
    expect(t.conversation).toMatchObject({
      subject: "How do I invite my colleague?",
      orgName: "Alpha Homes",
      needsHuman: false,
    });
    expect(t.messages.map((m) => [m.author, m.authorName])).toEqual([
      ["client", (await S.sql("SELECT name FROM users WHERE id = $1", [A.admin.userId]))[0].name],
      ["assistant", "PALTAS assistant"],
    ]);
    expect(t.assistantActive).toBe(true);
    const brief = seen[0]!.system;
    expect(brief).toContain("Alpha Homes");
    expect(brief).not.toContain("Bravo Homes"); // nothing about other clients
    expect(brief).toContain("[[HANDOVER]]");
    expect(seen[0]!.turns).toEqual([{ role: "user", content: "How do I invite my colleague?" }]);
    // the client continues; the whole conversation goes to the assistant as alternating turns
    const t2 = await A.admin.api.support.send({
      params: { conversationId: t.conversation.id },
      body: { message: "Thanks!" },
    });
    expect(t2.messages).toHaveLength(4);
    expect(seen[1]!.turns.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
  });

  it("a company the person does not belong to is refused, and conversations stay private", async () => {
    await refused(A.admin.api.support.start({ body: { orgId: B.orgId, message: "Hello" } }), 404);
    const mine = await A.admin.api.support.list();
    expect(mine.conversations.length).toBe(1);
    await refused(B.admin.api.support.get({ params: { conversationId: mine.conversations[0]!.id } }), 404);
    expect((await B.admin.api.support.list()).conversations).toEqual([]);
  });

  it("the assistant hands over to a person, and then stays quiet", async () => {
    next = () => "I am passing this to the PALTAS team — a person will reply here.\n[[HANDOVER]]";
    const t = await B.admin.api.support.start({ body: { orgId: B.orgId, message: "I paid twice, please refund me" } });
    expect(t.conversation.needsHuman).toBe(true);
    expect(t.assistantActive).toBe(false);
    expect(t.messages.map((m) => m.author)).toEqual(["client", "assistant", "system"]);
    expect(t.messages[1]!.body).not.toContain("[[HANDOVER]]");
    const calls = seen.length;
    const t2 = await B.admin.api.support.send({
      params: { conversationId: t.conversation.id },
      body: { message: "Hello?" },
    });
    expect(seen.length).toBe(calls); // the assistant did not answer
    expect(t2.messages.at(-1)!.author).toBe("client");
  });

  it("the client can ask for a person; no answer from the AI also goes to the team; and a daily limit", async () => {
    next = () => "Answer";
    const p = await A.admin.api.support.start({
      body: { orgId: A.orgId, message: "Can a person call me?", person: true },
    });
    expect(p.conversation.needsHuman).toBe(true);
    expect(p.messages.map((m) => m.author)).toEqual(["client", "system"]);
    next = () => null;
    const n = await A.admin.api.support.start({ body: { message: "Is PALTAS available in Uganda?" } });
    expect(n.conversation.needsHuman).toBe(true);
    expect(n.messages.at(-1)!.body).toMatch(/PALTAS team has your message/);
    // daily limit 3: A already had 2 assistant answers today; one more, then the team
    next = () => "Answer";
    const l1 = await A.admin.api.support.start({ body: { message: "Question one" } });
    expect(l1.messages.at(-1)!.author).toBe("assistant");
    const l2 = await A.admin.api.support.start({ body: { message: "Question two" } });
    expect(l2.messages.at(-1)!.author).toBe("system");
    expect(l2.conversation.needsHuman).toBe(true);
  });

  it("the PALTAS team sees everything, replies as themselves (the client gets an e-mail), notes stay internal", async () => {
    const sa = await S.staff();
    const inbox = await sa.api.admin.supportInbox();
    expect(inbox.counts.needsPerson).toBeGreaterThanOrEqual(3);
    const refund = inbox.conversations.find((c) => c.subject === "I paid twice, please refund me")!;
    expect(refund.client.email).toBe(B.admin.email);
    expect(refund.unread).toBeGreaterThan(0);
    expect(refund.lastMessage).toBe("Hello?");

    const support = await staffMember(S, "support");
    await support.api.admin.supportReply({
      params: { conversationId: refund.id },
      body: { message: "Checked the bank: the second payment is being returned.", internal: true },
    });
    const r = await support.api.admin.supportReply({
      params: { conversationId: refund.id },
      body: { message: "Hello! I found the second payment and we are returning it today." },
    });
    expect(r.messages.at(-1)!.authorName).toBe("support · PALTAS team");
    const mail = await S.sql(
      "SELECT to_address, subject, body FROM notifications WHERE template_key = 'support.reply'",
    );
    expect(mail).toHaveLength(1);
    expect(mail[0].to_address).toBe(B.admin.email.toLowerCase());
    expect(mail[0].body).toContain("returning it today");
    expect(mail[0].body).not.toContain("Checked the bank");

    const client = await B.admin.api.support.get({ params: { conversationId: refund.id } });
    expect(client.messages.some((m) => m.internal || /Checked the bank/.test(m.body))).toBe(false);
    expect(client.messages.at(-1)!.body).toMatch(/returning it today/);
    // answered: off the "needs a person" list, assigned to whoever answered
    const after = await sa.api.admin.supportInbox();
    expect(after.conversations.find((c) => c.id === refund.id)).toBeUndefined();
    const all = await sa.api.admin.supportInbox({ query: { view: "open" } });
    expect(all.conversations.find((c) => c.id === refund.id)!.assignedTo!.userId).toBe(support.userId);
    // the staff view shows the internal note
    const full = await sa.api.admin.supportThread({ params: { conversationId: refund.id } });
    expect(full.messages.find((m) => m.internal)!.body).toMatch(/Checked the bank/);
  });

  it("only staff who may answer clients reply; closing and handing back are recorded", async () => {
    const id = (await A.admin.api.support.list()).conversations[0]!.id;
    const finance = await staffMember(S, "finance");
    await finance.api.admin.supportThread({ params: { conversationId: id } }); // everyone on the team can read
    await refused(
      finance.api.admin.supportReply({ params: { conversationId: id }, body: { message: "Hi" } }),
      403,
      "STAFF_ROLE_NOT_ALLOWED",
    );
    await refused(A.admin.api.admin.supportInbox(), 404); // clients do not even see the endpoint
    const sa = await S.staff();
    await refused(sa.api.support.list(), 403); // staff use the inbox
    await refused(
      sa.api.admin.supportUpdate({ params: { conversationId: id }, body: { assignedTo: finance.userId } }),
      400,
    );
    await sa.api.admin.supportUpdate({
      params: { conversationId: id },
      body: { status: "closed", reason: "Answered by phone" },
    });
    const closed = await A.admin.api.support.get({ params: { conversationId: id } });
    expect(closed.conversation.status).toBe("closed");
    expect(closed.messages.at(-1)!.body).toMatch(/closed this conversation/);
    // writing again opens it again
    const again = await A.admin.api.support.send({
      params: { conversationId: id },
      body: { message: "One more thing" },
    });
    expect(again.conversation.status).toBe("open");
    const audit = await S.sql("SELECT detail FROM audit_log WHERE action = 'Support conversation changed'");
    expect(audit[0].detail).toContain("Answered by phone");
  });
});

describe("support chat without an AI key", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await startServer({ supportAssistant: null });
  });
  afterAll(() => S.close());

  it("every message goes to the PALTAS team, and the client is told so", async () => {
    const A = await S.newOrg({ name: "Charlie Homes" });
    const t = await A.admin.api.support.start({ body: { orgId: A.orgId, message: "Hello, I need help" } });
    expect(t.assistantActive).toBe(false);
    expect(t.conversation.needsHuman).toBe(true);
    expect(t.messages.map((m) => m.author)).toEqual(["client", "system"]);
    const sa = await S.staff();
    expect((await sa.api.admin.supportInbox()).counts.needsPerson).toBe(1);
  });
});

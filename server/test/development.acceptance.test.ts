// Real Estate Development, end to end on a real server and database, through the typed client:
//   project → units → buyer → offer → reservation → signed agreement with a payment plan → buyer payments reported and
//   verified → billing → statement of account;
//   budget → requisition → purchase order → delivery → supplier invoice (three-way checks, credit note) → approval →
//   payment run (prepare, approve, execute, reconcile) → cost report equal to the ledger; retention release;
//   practical completion → handover (revenue and cost of sale) → defect → after-sales;
//   and the dashboard, every money figure equal to the ledger.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildProject,
  devOrg,
  doc,
  M,
  PLAN_10_50_40,
  PLAN_CASH,
  startDevServer,
  type DevStaff,
} from "./support/development-fixture.js";
import { refused, TODAY, type Person, type TestServer } from "./support/test-server.js";

describe("Real Estate Development: acceptance", () => {
  let S: TestServer;
  let orgId: string;
  let st: DevStaff;
  let projectId: string;
  let units: { id: string; unitNo: string }[];
  let buyerId: string;
  let contractId: string;
  let cashContractId: string;
  const invoiceIds: string[] = [];
  let jengaPoId: string;
  const d = (p: Person) => p.api.development;
  const O = () => ({ orgId });
  const tb = async (asOf: string) => {
    const t = await st.fd.api.ledger.trialBalance({ params: O(), query: { asOf } });
    expect(t.balanced).toBe(true);
    return (code: string) => {
      const r = t.rows.find((x) => x.code === code);
      return r ? r.debitMinor - r.creditMinor : 0;
    };
  };

  beforeAll(async () => {
    S = await startDevServer();
    const o = await devOrg(S, "Acacia Developments");
    orgId = o.orgId;
    st = o.staff;
    const p = await buildProject(st.ceo, orgId);
    projectId = p.projectId;
    units = p.units;
  });
  afterAll(() => S.close());

  it("project → building → units, with the stock and the plan allowance", async () => {
    const p = await d(st.aud).getProject({ params: { orgId, projectId } });
    expect(p).toMatchObject({ name: "Riverside Gardens", unitCount: 4, soldCount: 0, unitsByStatus: { available: 4 } });
    expect(p.buildings).toEqual([expect.objectContaining({ name: "Block A", floorsCount: 5 })]);
    expect(units.map((u) => u.unitNo)).toEqual(["A101", "A102", "A103", "A104"]);
    await refused(
      d(st.ceo).createUnits({
        params: { orgId, projectId },
        body: { units: [{ unitNo: "a101", listPriceMinor: M(1e6) }] },
      }),
      409,
    );
    const settings = await d(st.aud).getSettings({ params: O() });
    expect(settings.costCodes.map((c) => c.code)).toContain("06");
    expect(settings).toMatchObject({ reservationDays: 14, priceToleranceBp: 200, bankHoldHours: 48 });
  });

  it("buyer → offer → buyer accepts → reservation approved → signed agreement with its instalment schedule", async () => {
    const b = await d(st.ag1).createBuyer({
      params: O(),
      body: { name: "Grace Mwende", email: "grace@example.com", phone: "+254 722 000 111", source: "Website enquiry" },
    });
    buyerId = b.id;
    expect([b.agentUserId, b.stage]).toEqual([st.ag1.userId, "enquiry"]);
    // the same person is in the organisation's one contact store
    const [contact] = await S.sql("SELECT name, types FROM contacts WHERE org_id = $1 AND id = $2", [
      orgId,
      b.contactId,
    ]);
    expect(contact).toEqual({ name: "Grace Mwende", types: ["prospect"] });
    // the same person again (same phone, written differently) is refused
    const dup = await refused(
      d(st.ag2).createBuyer({ params: O(), body: { name: "G. Mwende", phone: "0722000111" } }),
      409,
    );
    expect(dup.details).toEqual({ duplicateId: b.id });

    const a101 = units[0]!.id;
    const offer = await d(st.ag1).createOffer({
      params: O(),
      body: { buyerId, unitId: a101, priceMinor: M(14.7e6), plan: PLAN_10_50_40, validDays: 7 },
    });
    expect([offer.status, offer.discountBp, offer.askingMinor]).toEqual(["draft", 200, M(15e6)]);
    const sent = await d(st.ag1).submitOffer({ params: { orgId, offerId: offer.id } });
    expect([sent.status, sent.validUntil, sent.approval]).toEqual(["submitted", "2026-10-18", null]);
    const accepted = await d(st.ag1).respondToOffer({
      params: { orgId, offerId: offer.id },
      body: { response: "accept" },
    });
    expect(accepted.status).toBe("accepted");
    const { units: held } = await d(st.aud).listUnits({ params: { orgId, projectId }, query: { status: "on_hold" } });
    expect(held.map((u) => u.unitNo)).toEqual(["A101"]);

    const r = await d(st.sm).approveReservation({ params: { orgId, reservationId: accepted.reservationId! } });
    expect([r.status, r.expiryDate, r.approvedBy]).toEqual(["active", "2026-10-25", st.sm.userId]);

    const signed = await doc(st.sm, orgId, "SA-A101-signed.pdf", "sale_agreement");
    const k = await d(st.sm).signContract({
      params: { orgId, reservationId: r.id },
      body: { date: TODAY, signedDocumentId: signed.id },
    });
    contractId = k.id;
    expect([k.priceMinor, k.plan, k.instalments.length]).toEqual([M(14.7e6), PLAN_10_50_40, 14]);
    expect(k.instalments[0]).toMatchObject({ dueDate: TODAY, amountMinor: M(1.47e6), description: "Deposit 10%" });
    expect(k.instalments[1]).toMatchObject({ dueDate: "2026-11-11", amountMinor: M(612_500) });
    // the balance falls due at the project's planned completion (as in the workspace's payment plans)
    expect(k.instalments.find((i) => i.description === "Balance on completion")).toMatchObject({
      dueDate: "2027-06-30",
      amountMinor: M(5.88e6),
    });
    expect(k.instalments.reduce((n, i) => n + i.amountMinor, 0)).toBe(M(14.7e6));
    const unit = (await d(st.aud).listUnits({ params: { orgId, projectId }, query: { status: "sold" } })).units;
    expect(unit.map((u) => u.unitNo)).toEqual(["A101"]);
    const docs = await d(st.aud).listDocuments({ params: O(), query: { linkEntity: "contract", linkId: k.id } });
    expect(docs.documents.map((x) => x.filename)).toEqual(["SA-A101-signed.pdf"]);
    expect((await d(st.ag1).getBuyer({ params: { orgId, buyerId } })).stage).toBe("contracted");
  });

  it("a buyer payment is recorded by sales, verified by finance and posted: Dr 1010 / Cr 2400 (paid before billing)", async () => {
    const k = (await d(st.ag1).listContracts({ params: O(), query: { buyerId } })).contracts[0]!;
    const deposit = k.instalments[0]!;
    // sales report one instalment in full; a part-payment goes through finance
    await refused(
      d(st.ag1).reportPayment({
        params: { orgId, contractId },
        body: {
          instalmentId: deposit.id,
          amountMinor: M(1e6),
          method: "bank_transfer",
          reference: "FT26101100001",
          date: TODAY,
        },
      }),
      400,
    );
    const proof = await doc(st.ag1, orgId, "deposit-proof.pdf", "proof_of_payment");
    const rep = await d(st.ag1).reportPayment({
      params: { orgId, contractId },
      body: {
        instalmentId: deposit.id,
        amountMinor: M(1.47e6),
        method: "bank_transfer",
        reference: "FT26101100001",
        date: TODAY,
        proofDocumentId: proof.id,
      },
    });
    expect(rep.status).toBe("awaiting_verification");
    // the agent cannot verify, and nothing is on the ledger yet
    await refused(
      d(st.ag1).verifyPayment({ params: { orgId, reportId: rep.id }, body: { approve: true } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    expect((await tb(TODAY))("1010")).toBe(0);
    const ok = await d(st.acct).verifyPayment({ params: { orgId, reportId: rep.id }, body: { approve: true } });
    expect([ok.status, ok.verifiedBy, ok.receiptNumber]).toEqual(["verified", st.acct.userId, "RCT-00001"]);
    const bal = await tb(TODAY);
    expect([bal("1010"), bal("2400"), bal("1170")]).toEqual([M(1.47e6), -M(1.47e6), 0]);
    // the same bank reference is never recorded twice
    await refused(
      d(st.fd).reportPayment({
        params: { orgId, contractId },
        body: { amountMinor: M(1000), method: "bank_transfer", reference: "ft26101100001", date: TODAY },
      }),
      409,
    );
  });

  it("budget → requisition → order → delivery → invoice with a three-way exception, credit note, approval and posting", async () => {
    const P = { orgId, projectId };
    await d(st.pm).setBudget({
      params: P,
      body: {
        lines: [
          { costCode: "06", originalMinor: M(50e6), etcMinor: M(50e6), note: "QS estimate v1" },
          { costCode: "13", originalMinor: M(10e6) },
        ],
      },
    });
    // suppliers: registered by procurement, approved by finance
    const simba = await d(st.proc).registerSupplier({
      params: O(),
      body: {
        kind: "supplier",
        name: "Simba Cement Distributors",
        taxId: "P051000000P",
        bankAccount: "0123456789",
        trade: "Cement",
      },
    });
    expect([simba.status, simba.paymentsBlocked, simba.bankAccount]).toEqual(["pending", true, "••6789"]);
    await refused(
      d(st.proc).approveSupplier({ params: { orgId, supplierId: simba.id }, body: {} }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await d(st.fd).approveSupplier({ params: { orgId, supplierId: simba.id }, body: { rating: 4.2 } });

    const req = await d(st.pm).createRequisition({
      params: P,
      body: { costCode: "06", item: "Cement 42.5N, 50kg bag", qty: 6000, unit: "bag", estUnitPriceMinor: M(780) },
    });
    expect([req.status, req.estimateMinor]).toEqual(["pending", M(4.68e6)]);
    await refused(
      d(st.pm).decideRequisition({ params: { orgId, requisitionId: req.id }, body: { approve: true } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await d(st.proc).decideRequisition({ params: { orgId, requisitionId: req.id }, body: { approve: true } });

    const po = await d(st.proc).createPurchaseOrder({
      params: P,
      body: {
        kind: "po",
        supplierId: simba.id,
        costCode: "06",
        description: "Cement for Block A slabs",
        requisitionId: req.id,
        lines: [{ item: "Cement 42.5N, 50kg bag", unit: "bag", qty: 6000, unitPriceMinor: M(780) }],
      },
    });
    expect([po.status, po.amountMinor]).toEqual(["pending_approval", M(4.68e6)]);
    let cost = await d(st.pm).costReport({ params: P });
    expect(cost.rows.find((r) => r.costCode === "06")).toMatchObject({ proposedMinor: M(4.68e6), committedMinor: 0 });
    await refused(
      d(st.proc).decidePurchaseOrder({ params: { orgId, poId: po.id }, body: { approve: true } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    const approved = await d(st.fd).decidePurchaseOrder({ params: { orgId, poId: po.id }, body: { approve: true } });
    expect([approved.status, approved.approvedBy]).toEqual(["approved", st.fd.userId]);

    const line = approved.lines[0]!;
    await d(st.pm).recordDelivery({
      params: { orgId, poId: po.id },
      body: {
        date: TODAY,
        note: "50 bags split, returned",
        lines: [{ poLineId: line.id, receivedQty: 4000, acceptedQty: 3950 }],
      },
    });
    const evidence = await doc(st.ap, orgId, "SCD-88412.pdf", "supplier_invoice");
    const inv = await d(st.ap).captureInvoice({
      params: O(),
      body: {
        supplierId: simba.id,
        projectId,
        purchaseOrderId: po.id,
        supplierInvoiceNo: "SCD-88412",
        date: TODAY,
        dueDate: "2026-10-25",
        description: "Delivery 1 of 2",
        lines: [{ poLineId: line.id, qty: 4000, unitPriceMinor: M(780) }],
        vatBp: 1600,
        evidenceDocumentId: evidence.id,
      },
    });
    expect(inv.status).toBe("exception");
    expect(inv.exceptions).toEqual(["Cement 42.5N, 50kg bag: billed 4000, only 3950 accepted and not yet invoiced"]);
    expect(inv.match![0]).toMatchObject({ acceptedQty: 3950, invoicedQty: 4000, qtyOk: false, priceOk: true });
    await refused(d(st.fd).decideInvoice({ params: { orgId, invoiceId: inv.id }, body: { action: "approve" } }), 409);
    const credited = await d(st.ap).applyCreditNote({
      params: { orgId, invoiceId: inv.id },
      body: {
        supplierCreditNo: "SCD-CN-0291",
        reason: "50 damaged bags returned",
        lines: [{ poLineId: line.id, qty: 50 }],
      },
    });
    expect(credited).toMatchObject({
      status: "matched",
      netMinor: M(3_081_000),
      vatMinor: M(492_960),
      payableMinor: M(3_573_960),
      creditNotesMinor: M(39_000),
    });
    // accounts payable captures but cannot approve
    await refused(
      d(st.ap).decideInvoice({ params: { orgId, invoiceId: inv.id }, body: { action: "approve" } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const posted = await d(st.fd).decideInvoice({ params: { orgId, invoiceId: inv.id }, body: { action: "approve" } });
    expect([posted.status, posted.approvedBy]).toEqual(["approved", st.fd.userId]);
    const j = await st.fd.api.ledger.getJournal({ params: { orgId, journalId: posted.journalId! } });
    expect(j.lines.map((l) => [l.account, l.debitMinor, l.creditMinor])).toEqual([
      ["1530", M(3_081_000), 0],
      ["1200", M(492_960), 0],
      ["2000", 0, M(3_573_960)],
    ]);
    invoiceIds.push(inv.id);

    // a works contract with 10 % retention, invoiced without order lines (withholding tax 3 %)
    const jenga = await d(st.proc).registerSupplier({
      params: O(),
      body: { kind: "contractor", name: "Jenga Builders Ltd", taxId: "P051999999J", bankAccount: "9988776655" },
    });
    await d(st.fd).approveSupplier({ params: { orgId, supplierId: jenga.id }, body: {} });
    const sc = await d(st.proc).createPurchaseOrder({
      params: P,
      body: {
        kind: "contract",
        supplierId: jenga.id,
        costCode: "06",
        description: "Superstructure works",
        amountMinor: M(10e6),
        retentionBp: 1000,
      },
    });
    jengaPoId = sc.id;
    await d(st.fd).decidePurchaseOrder({ params: { orgId, poId: sc.id }, body: { approve: true } });
    const cert = await doc(st.ap, orgId, "JB-IPC-01.pdf", "payment_certificate");
    const ipc = await d(st.ap).captureInvoice({
      params: O(),
      body: {
        supplierId: jenga.id,
        projectId,
        purchaseOrderId: sc.id,
        supplierInvoiceNo: "JB-IPC-01",
        date: TODAY,
        dueDate: "2026-10-25",
        description: "Interim payment certificate 1",
        netMinor: M(2e6),
        vatBp: 1600,
        whtBp: 300,
        evidenceDocumentId: cert.id,
      },
    });
    expect(ipc).toMatchObject({
      status: "matched",
      vatMinor: M(320_000),
      retentionMinor: M(200_000),
      whtMinor: M(60_000),
      payableMinor: M(2_120_000),
      cashMinor: M(2_060_000),
    });
    await d(st.fd).decideInvoice({ params: { orgId, invoiceId: ipc.id }, body: { action: "approve" } });
    invoiceIds.push(ipc.id);
    cost = await d(st.pm).costReport({ params: P });
    expect(cost.rows.find((r) => r.costCode === "06")).toMatchObject({
      revisedMinor: M(50e6),
      committedMinor: M(14.68e6),
      invoicedMinor: M(5_081_000),
      paidMinor: 0,
      openCommitmentMinor: M(9_599_000),
      etcMinor: M(35.32e6),
      eacMinor: M(50e6),
      varianceMinor: 0,
    });
    expect(cost.ledger).toEqual({ invoicedMinor: M(5_081_000), agrees: true });
    expect((await tb(TODAY))("1530")).toBe(M(5_081_000));
  });

  it("payment run: prepared by AP, approved by finance, executed by treasury, reconciled by someone else", async () => {
    const run = await d(st.ap).preparePaymentRun({ params: O(), body: { dueWithinDays: 30 } });
    expect([run.status, run.totalMinor, [...run.invoiceIds].sort()]).toEqual([
      "awaiting_approval",
      M(3_573_960 + 2_060_000),
      [...invoiceIds].sort(),
    ]);
    await refused(d(st.ap).approvePaymentRun({ params: { orgId, runId: run.id } }), 403, "ROLE_NOT_ALLOWED");
    await d(st.fd).approvePaymentRun({ params: { orgId, runId: run.id } });
    await refused(d(st.fd).executePaymentRun({ params: { orgId, runId: run.id } }), 403, "ROLE_NOT_ALLOWED");
    const ex = await d(st.treasury).executePaymentRun({ params: { orgId, runId: run.id } });
    expect(ex.run.status).toBe("sent");
    expect(ex.bankFile.content.split("\r\n")[0]).toBe("reference,supplier,account,amount_minor");
    expect(ex.bankFile.content).toContain("Jenga Builders Ltd");
    let bal = await tb(TODAY);
    // payable cleared (with the withholding tax kept for the tax authority), retention still held
    expect([bal("2000"), bal("2050"), bal("2200"), bal("1000")]).toEqual([0, -M(200_000), -M(60_000), -M(5_633_960)]);
    // not paid until the statement is matched — and never by the person who executed the run
    expect((await d(st.aud).getInvoice({ params: { orgId, invoiceId: invoiceIds[0]! } })).status).toBe("sent");
    const lines = ex.run.payments.map((p) => ({ date: TODAY, reference: p.reference, amountMinor: -p.amountMinor }));
    const mine = await d(st.treasury).reconcilePayments({ params: O(), body: { lines } });
    expect(mine.matched).toBe(0);
    expect(mine.unmatched.every((u) => u.reason.includes("someone else"))).toBe(true);
    const rec = await d(st.acct).reconcilePayments({
      params: O(),
      body: { lines: [...lines, { date: TODAY, reference: "BNK-CHARGES", amountMinor: -M(31.5) }] },
    });
    expect([rec.matched, rec.unmatched.map((u) => u.reason)]).toEqual([2, ["No sent payment with this reference"]]);
    for (const id of invoiceIds)
      expect((await d(st.aud).getInvoice({ params: { orgId, invoiceId: id } })).status).toBe("paid");
    expect((await d(st.aud).listPaymentRuns({ params: O() })).runs[0]!.status).toBe("reconciled");
    const cost = await d(st.pm).costReport({ params: { orgId, projectId } });
    expect(cost.rows.find((r) => r.costCode === "06")!.paidMinor).toBe(M(5_081_000));

    // retention released on the contract becomes payable once finance approves it
    const rel = await d(st.ap).releaseRetention({
      params: { orgId, poId: jengaPoId },
      body: { amountMinor: M(200_000), reason: "Defects period ended, all defects closed", dueDate: "2026-10-31" },
    });
    expect([rel.kind, rel.status, rel.payableMinor]).toEqual(["retention_release", "matched", M(200_000)]);
    await refused(
      d(st.ap).releaseRetention({
        params: { orgId, poId: jengaPoId },
        body: { amountMinor: 1, reason: "Release more", dueDate: "2026-10-31" },
      }),
      400,
    );
    await d(st.fd).decideInvoice({ params: { orgId, invoiceId: rel.id }, body: { action: "approve" } });
    bal = await tb(TODAY);
    expect([bal("2050"), bal("2000")]).toEqual([0, -M(200_000)]);
  });

  it("billing: instalments due are billed once (Dr 1170 / Cr 2400); finance records a receipt that clears them", async () => {
    S.setToday("2026-11-12");
    const b = await d(st.acct).billInstalments({ params: O(), body: {} });
    expect([b.billed, b.amountMinor, b.journalIds.length]).toEqual([2, M(612_500), 1]); // the deposit was already paid
    expect((await d(st.acct).billInstalments({ params: O(), body: {} })).billed).toBe(0);
    let dash = await d(st.fd).dashboard({ params: O(), query: {} });
    expect(dash.collections.receivables).toEqual({ subledgerMinor: M(612_500), ledgerMinor: M(612_500), agrees: true });
    expect(dash.collections).toMatchObject({
      dueToDateMinor: M(2_082_500),
      collectedMinor: M(1.47e6),
      overdueMinor: M(612_500),
    });

    const rep = await d(st.fd).reportPayment({
      params: { orgId, contractId },
      body: { amountMinor: M(612_500), method: "mobile_money", reference: "SKL4QX9ZT2", date: "2026-11-12" },
    });
    expect(rep.source).toBe("Recorded by finance");
    await refused(
      d(st.fd).verifyPayment({ params: { orgId, reportId: rep.id }, body: { approve: true } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await d(st.acct).verifyPayment({ params: { orgId, reportId: rep.id }, body: { approve: true } });
    dash = await d(st.fd).dashboard({ params: O(), query: {} });
    expect(dash.collections.receivables).toEqual({ subledgerMinor: 0, ledgerMinor: 0, agrees: true });
    expect(dash.collections).toMatchObject({ overdueMinor: 0, collectedPct: 100, depositsHeldMinor: M(2_082_500) });

    const sa = await d(st.ag1).contractStatement({ params: { orgId, contractId }, query: {} });
    expect(sa.lines.map((l) => [l.date, l.kind, l.debitMinor, l.creditMinor])).toEqual([
      [TODAY, "instalment", M(1.47e6), 0],
      [TODAY, "receipt", 0, M(1.47e6)],
      ["2026-11-11", "instalment", M(612_500), 0],
      ["2026-11-12", "receipt", 0, M(612_500)],
    ]);
    expect(sa.totals).toEqual({
      dueToDateMinor: M(2_082_500),
      paidMinor: M(2_082_500),
      overdueMinor: 0,
      notYetDueMinor: M(14.7e6 - 2_082_500),
      balanceMinor: M(14.7e6 - 2_082_500),
    });
    expect(sa.instalments[1]).toMatchObject({ paidMinor: M(612_500), openMinor: 0, receivableMinor: 0 });
  });

  it("handover: refused before practical completion and while money is owed; then revenue and cost of sale", async () => {
    const a102 = units[1]!.id;
    const o = await d(st.ag1).createOffer({
      params: O(),
      body: { buyerId, unitId: a102, priceMinor: M(15e6), plan: PLAN_CASH },
    });
    await d(st.ag1).submitOffer({ params: { orgId, offerId: o.id } });
    const acc = await d(st.ag1).respondToOffer({ params: { orgId, offerId: o.id }, body: { response: "accept" } });
    await d(st.sm).approveReservation({ params: { orgId, reservationId: acc.reservationId! } });
    const k = await d(st.sm).signContract({
      params: { orgId, reservationId: acc.reservationId! },
      body: { date: "2026-11-12", signedDocumentId: (await doc(st.sm, orgId, "SA-A102.pdf")).id },
    });
    cashContractId = k.id;
    const certificate = await doc(st.sm, orgId, "handover-A102.pdf", "handover_certificate");
    const ho = {
      params: { orgId, contractId: cashContractId },
      body: { date: "2026-11-12", certificateDocumentId: certificate.id },
    };
    await refused(d(st.sm).recordHandover(ho), 409); // not paid
    const rep = await d(st.ag1).reportPayment({
      params: { orgId, contractId: cashContractId },
      body: {
        instalmentId: k.instalments[0]!.id,
        amountMinor: M(15e6),
        method: "mortgage_drawdown",
        reference: "MTG-55120-A102",
        date: "2026-11-12",
      },
    });
    await d(st.treasury).verifyPayment({ params: { orgId, reportId: rep.id }, body: { approve: true } });
    const pcErr = await refused(d(st.sm).recordHandover(ho), 409);
    expect(pcErr.message).toContain("Practical completion");
    const pc = await d(st.pm).createMilestone({
      params: { orgId, projectId },
      body: { name: "Practical completion", dueDate: "2026-11-10", practicalCompletion: true },
    });
    await d(st.pm).updateMilestone({ params: { orgId, milestoneId: pc.id }, body: { completedDate: "2026-11-12" } });
    // A101 still owes most of its price
    await refused(d(st.sm).recordHandover({ ...ho, params: { orgId, contractId } }), 409);
    await refused(d(st.ag1).recordHandover(ho), 403, "ROLE_NOT_ALLOWED");
    const h = await d(st.sm).recordHandover(ho);
    // 4 units of 85 m² not yet handed over: this unit carries a quarter of the project's WIP
    expect([h.revenueMinor, h.costOfSaleMinor]).toEqual([M(15e6), M(5_081_000) / 4]);
    await refused(d(st.sm).recordHandover(ho), 409);
    const bal = await tb("2026-11-12");
    expect([bal("4600"), bal("5700"), bal("1530"), bal("2400")]).toEqual([
      -M(15e6),
      M(5_081_000) / 4,
      M(5_081_000) - M(5_081_000) / 4,
      -M(2_082_500),
    ]);
    const tasks = await d(st.ag1).listTasks({ params: O(), query: { view: "mine" } });
    expect(tasks.tasks.map((t) => t.title)).toContain("After-sales check-in · unit A102");
  });

  it("defects after handover (closed by someone other than the fixer) and an after-sales request", async () => {
    const a102 = units[1]!.id;
    const df = await d(st.sm).reportDefect({
      params: { orgId, unitId: a102 },
      body: { description: "Kitchen tap leaking", assigneeUserId: st.pm.userId, dueDate: "2026-11-19" },
    });
    expect([df.status, df.handoverId !== null]).toEqual(["open", true]);
    expect((await d(st.pm).listTasks({ params: O(), query: { view: "mine" } })).tasks.map((t) => t.id)).toContain(
      df.taskId,
    );
    await d(st.pm).updateDefect({
      params: { orgId, defectId: df.id },
      body: { status: "fixed", note: "Washer replaced" },
    });
    await refused(
      d(st.pm).updateDefect({ params: { orgId, defectId: df.id }, body: { status: "closed" } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    expect(
      (await d(st.sm).updateDefect({ params: { orgId, defectId: df.id }, body: { status: "closed" } })).status,
    ).toBe("closed");
    const t = await d(st.ag1).afterSalesRequest({
      params: { orgId, buyerId },
      body: { title: "Spare keys for the meter box" },
    });
    expect([t.category, t.assigneeUserId]).toEqual(["aftersales", st.ag1.userId]);
    expect((await d(st.ag1).getBuyer({ params: { orgId, buyerId } })).stage).toBe("after_sales");
  });

  it("the dashboard: sales, collections, cost, payables, cash and revenue — each equal to the ledger", async () => {
    const dash = await d(st.ceo).dashboard({ params: O(), query: {} });
    expect(dash.sales).toEqual({
      unitsByStatus: { handed_over: 1, sold: 1, available: 2 },
      contractValueMinor: M(14.7e6 + 15e6),
      unsoldStockMinor: M(30e6),
      openOffers: 0,
    });
    expect(dash.collections).toMatchObject({
      dueToDateMinor: M(2_082_500 + 15e6),
      collectedMinor: M(2_082_500 + 15e6),
      receivables: { agrees: true },
      depositsHeldMinor: M(2_082_500),
    });
    expect(dash.cost).toMatchObject({
      invoicedMinor: M(5_081_000),
      ledger: { subledgerMinor: M(5_081_000), ledgerMinor: M(5_081_000), agrees: true },
    });
    expect(dash.payables).toEqual({
      accountsPayable: { subledgerMinor: M(200_000), ledgerMinor: M(200_000), agrees: true },
      retention: { subledgerMinor: 0, ledgerMinor: 0, agrees: true },
    });
    expect(dash.cash).toEqual({
      operatingMinor: -M(5_633_960),
      collectionsMinor: M(17_082_500),
      totalMinor: M(17_082_500 - 5_633_960),
    });
    expect(dash.revenue).toEqual({ recognisedMinor: M(15e6), costOfSalesMinor: M(5_081_000) / 4 });
    // every posting is an automatic Development journal, once per source document
    const { journals } = await st.fd.api.ledger.listJournals({ params: O(), query: {} });
    expect(new Set(journals.map((j) => j.source))).toEqual(new Set(["system:development"]));
    expect(journals.every((j) => j.status === "posted")).toBe(true);
  });

  it("approvals inbox shows only what each person may decide", async () => {
    const req = await d(st.pm).createRequisition({
      params: { orgId, projectId },
      body: { costCode: "07", item: "Floor tiles 600x600", qty: 4200, unit: "m²", estUnitPriceMinor: M(1850) },
    });
    const inbox = async (p: Person) => (await d(p).approvals({ params: O() })).items.map((i) => i.id);
    expect(await inbox(st.pm)).not.toContain(req.id); // their own
    expect(await inbox(st.proc)).not.toContain(req.id); // KES 7.77M is above procurement's 5M
    expect(await inbox(st.fd)).toContain(req.id);
    expect(await inbox(st.ceo)).toContain(req.id);
  });
});

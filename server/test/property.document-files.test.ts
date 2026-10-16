import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { pmOrg, setUpBuilding, startPropertyServer } from "./support/property-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

describe("private property document files", () => {
  let S: TestServer;
  let orgId: string;
  let pm: Person;
  let viewer: Person;
  let other: Person;
  let documentId: string;
  const data = Buffer.from("%PDF-1.4\nSynthetic test only\n%%EOF");
  const file = {
    filename: "inspection.pdf",
    mediaType: "application/pdf" as const,
    contentBase64: data.toString("base64"),
  };
  beforeAll(async () => {
    S = await startPropertyServer();
    const o = await pmOrg(S, { name: "Private Documents" });
    orgId = o.orgId;
    pm = o.staff.property_manager;
    viewer = await S.addMember(orgId, o.admin.api, "viewer");
    const alt = await pmOrg(S, { name: "Other Documents" });
    other = alt.staff.property_manager;
    const b = await setUpBuilding(orgId, pm, { units: ["A1"] });
    const doc = await pm.api.property.addDocument({
      params: { orgId },
      body: {
        name: "Inspection evidence",
        docType: "inspection",
        linkEntity: "property",
        linkId: b.propertyId,
        filename: file.filename,
        visibility: "staff",
      },
    });
    documentId = doc.id;
  });
  afterAll(() => S.close());
  it("stores and returns exact private bytes and computes the hash on the server", async () => {
    const r = await pm.api.property.uploadDocumentFile({ params: { orgId, documentId }, body: file });
    expect(r).toEqual({
      stored: true,
      sizeBytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    const f = await pm.api.property.downloadDocumentFile({ params: { orgId, documentId } });
    expect(f.contentBase64).toBe(file.contentBase64);
    expect((await pm.api.property.listDocuments({ params: { orgId } })).documents[0]?.fileStored).toBe(true);
    expect(
      (
        await S.sql(
          "SELECT octet_length(content)::int AS n FROM pm_document_files WHERE org_id=$1 AND document_id=$2",
          [orgId, documentId],
        )
      )[0]?.n,
    ).toBe(data.length);
  });
  it("does not overwrite an existing file version", async () => {
    await refused(pm.api.property.uploadDocumentFile({ params: { orgId, documentId }, body: file }), 409);
  });
  it("refuses writes by read-only viewers and cross-company file access", async () => {
    await refused(viewer.api.property.uploadDocumentFile({ params: { orgId, documentId }, body: file }), 403);
    await refused(other.api.property.downloadDocumentFile({ params: { orgId, documentId } }), 404);
    await refused(other.api.property.uploadDocumentFile({ params: { orgId, documentId }, body: file }), 404);
  });
  it("rejects incorrect type signatures and active content disguised as text", async () => {
    await refused(
      pm.api.property.uploadDocumentFile({
        params: { orgId, documentId },
        body: { ...file, contentBase64: Buffer.from("<html>bad</html>").toString("base64") },
      }),
      400,
    );
    await refused(
      pm.api.property.uploadDocumentFile({
        params: { orgId, documentId },
        body: {
          filename: "bad.txt",
          mediaType: "text/plain",
          contentBase64: Buffer.from("<script>alert(1)</script>").toString("base64"),
        },
      }),
      400,
    );
  });
  it("rejects oversized files and filenames containing paths", async () => {
    await refused(
      pm.api.property.uploadDocumentFile({
        params: { orgId, documentId },
        body: { ...file, contentBase64: Buffer.alloc(2097153, 65).toString("base64") },
      }),
      400,
    );
    await refused(
      pm.api.property.uploadDocumentFile({
        params: { orgId, documentId },
        body: { ...file, filename: "../outside.pdf" },
      }),
      400,
    );
  });
  it("allows only the linked tenant or owner to download explicitly shared files", async () => {
    const o = await pmOrg(S, { name: "Portal Documents" });
    const manager = o.staff.property_manager;
    const b = await setUpBuilding(o.orgId, manager, { units: ["T1"] });
    const tenant = await S.addMember(o.orgId, o.admin.api, "tenant");
    const stranger = await S.addMember(o.orgId, o.admin.api, "tenant");
    const owner = await S.addMember(o.orgId, o.admin.api, "owner");
    const c = (
      await manager.api.contacts.createContact({
        params: { orgId: o.orgId },
        body: { name: "Document Tenant", types: ["tenant"] },
      })
    ).contact;
    const foreign = (
      await manager.api.contacts.createContact({
        params: { orgId: o.orgId },
        body: { name: "Other Tenant", types: ["tenant"] },
      })
    ).contact;
    await o.admin.api.contacts.updateContact({
      params: { orgId: o.orgId, contactId: c.id },
      body: { userId: tenant.userId },
    });
    await o.admin.api.contacts.updateContact({
      params: { orgId: o.orgId, contactId: foreign.id },
      body: { userId: stranger.userId },
    });
    await o.admin.api.contacts.updateContact({
      params: { orgId: o.orgId, contactId: b.ownerId },
      body: { userId: owner.userId },
    });
    const add = async (
      visibility: "staff" | "tenant" | "owner",
      linkEntity: "contact" | "property",
      linkId: string,
    ) => {
      const d = await manager.api.property.addDocument({
        params: { orgId: o.orgId },
        body: {
          name: "Shared inspection",
          docType: "inspection",
          linkEntity,
          linkId,
          filename: file.filename,
          visibility,
        },
      });
      await manager.api.property.uploadDocumentFile({ params: { orgId: o.orgId, documentId: d.id }, body: file });
      return d.id;
    };
    const shared = await add("tenant", "contact", c.id),
      privateDoc = await add("staff", "contact", c.id),
      ownerDoc = await add("owner", "property", b.propertyId);
    expect(
      (await tenant.api.property.downloadDocumentFile({ params: { orgId: o.orgId, documentId: shared } }))
        .contentBase64,
    ).toBe(file.contentBase64);
    await refused(stranger.api.property.downloadDocumentFile({ params: { orgId: o.orgId, documentId: shared } }), 404);
    await refused(
      tenant.api.property.downloadDocumentFile({ params: { orgId: o.orgId, documentId: privateDoc } }),
      404,
    );
    await refused(tenant.api.property.downloadDocumentFile({ params: { orgId: o.orgId, documentId: ownerDoc } }), 404);
    expect(
      (await owner.api.property.ownerPortal({ params: { orgId: o.orgId }, query: {} })).documents.map((d) => d.id),
    ).toContain(ownerDoc);
    expect(
      (await owner.api.property.downloadDocumentFile({ params: { orgId: o.orgId, documentId: ownerDoc } }))
        .contentBase64,
    ).toBe(file.contentBase64);
    await refused(owner.api.property.downloadDocumentFile({ params: { orgId: o.orgId, documentId: shared } }), 404);
    await refused(
      tenant.api.property.uploadDocumentFile({ params: { orgId: o.orgId, documentId: shared }, body: file }),
      403,
    );
  });

  it("keeps classified identity and employment files disabled", async () => {
    const o = await pmOrg(S, { name: "Sensitive document controls" });
    const b = await setUpBuilding(o.orgId, o.staff.property_manager);
    for (const docType of ["ID", "Passport", "Payslip", "Tenant screening"]) {
      const doc = await o.staff.property_manager.api.property.addDocument({
        params: { orgId: o.orgId },
        body: {
          name: "Reference only",
          docType,
          linkEntity: "property",
          linkId: b.propertyId,
          filename: file.filename,
          visibility: "staff",
        },
      });
      await refused(
        o.staff.property_manager.api.property.uploadDocumentFile({
          params: { orgId: o.orgId, documentId: doc.id },
          body: file,
        }),
        400,
      );
    }
  });

  it("can disable new uploads without disabling metadata", async () => {
    const stopped = await startPropertyServer({ pmDocumentFileUploadsEnabled: false });
    try {
      const o = await pmOrg(stopped),
        b = await setUpBuilding(o.orgId, o.staff.property_manager);
      const doc = await o.staff.property_manager.api.property.addDocument({
        params: { orgId: o.orgId },
        body: {
          name: "Metadata remains available",
          docType: "inspection",
          linkEntity: "property",
          linkId: b.propertyId,
          filename: file.filename,
          visibility: "staff",
        },
      });
      await refused(
        o.staff.property_manager.api.property.uploadDocumentFile({
          params: { orgId: o.orgId, documentId: doc.id },
          body: file,
        }),
        400,
      );
      expect(
        (await o.staff.property_manager.api.property.listDocuments({ params: { orgId: o.orgId } })).documents.map(
          (d) => d.id,
        ),
      ).toContain(doc.id);
    } finally {
      await stopped.close();
    }
  });

  it("records upload and download audit entries without document contents", async () => {
    const a = await S.sql(
      "SELECT action,detail FROM audit_log WHERE org_id=$1 AND target=$2 AND action LIKE 'Document file%'",
      [orgId, documentId],
    );
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(a)).not.toContain(file.contentBase64);
  });
});

/* ====================================================================== *
 * WHO MAY INVITE WHOM, AND TO WHAT.
 *
 * An invitation writes a Membership, and a Membership is the only thing that
 * decides what a person can reach. So this file is a privilege-escalation
 * surface, and the rules that matter are the ones about what a person may
 * hand out rather than what they may do themselves.
 *
 * Three of them:
 *
 *   NOBODY GRANTS WHAT THEY DO NOT HOLD. A manager cannot mint an owner. If
 *   they could, every manager is one invitation away from owning the company
 *   — invite yourself at a second address, accept, and the company has a new
 *   owner nobody approved.
 *
 *   PALTAS'S OWN ROLES ARE NOT A CUSTOMER'S TO GIVE. MARKETING, COMPLIANCE
 *   and PUBLISHER review promotions across every company on the platform. A
 *   customer handing one out would be a customer granting themselves approval
 *   of their own advertising.
 *
 *   A GUEST IS NOT STAFF. GUEST reaches nothing through the staff API by
 *   design; inviting somebody to it would be inviting them to an empty room
 *   and calling it a job.
 * ====================================================================== */

import crypto from "node:crypto";
import { ROLE_AREAS } from "./access.js";

/** Same construction as a session token, and for the same reason. */
export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

/** How long a link is good for. Long enough to be forwarded, short enough to matter. */
export const INVITE_DAYS = 14;

/**
 * PALTAS's own staff. These exist on the platform, not inside a customer.
 * `platform.js` is where they are granted; never an invitation.
 */
export const PLATFORM_ROLES = ["MARKETING", "COMPLIANCE", "PUBLISHER"];

/** Roles no company may ever hand out through an invitation. */
export const NEVER_INVITABLE = [...PLATFORM_ROLES, "GUEST"];

/** Only these two run a company, so only these two may bring somebody into it. */
export const CAN_INVITE = ["OWNER", "MANAGER"];

/**
 * The roles this inviter may grant.
 *
 * An OWNER may grant anything a company has, including OWNER — companies have
 * co-founders, and refusing that would mean the only way to add a second owner
 * is a database edit. A MANAGER may grant anything below OWNER.
 */
export function grantableBy(role) {
  if (!CAN_INVITE.includes(role)) return [];
  const all = Object.keys(ROLE_AREAS).filter((r) => !NEVER_INVITABLE.includes(r));
  return role === "OWNER" ? all : all.filter((r) => r !== "OWNER");
}

/**
 * Why this invitation cannot be sent — a sentence, or null when it can.
 *
 * Returns the reason rather than throwing so the route picks the status code,
 * the same contract as whyNot() in rights.js.
 */
export function whyNotInvite(inviterRole, wantedRole) {
  if (!CAN_INVITE.includes(inviterRole)) {
    return `The role “${inviterRole}” cannot invite people. Ask an owner or a manager.`;
  }
  if (!wantedRole) return "Say which role this person is being invited to.";
  if (!ROLE_AREAS[wantedRole]) return `“${wantedRole}” is not a role on PALTAS.`;
  if (NEVER_INVITABLE.includes(wantedRole)) {
    return PLATFORM_ROLES.includes(wantedRole)
      ? `“${wantedRole}” is a PALTAS staff role and is not a company's to grant.`
      : "A guest is not staff and cannot be invited to a company.";
  }
  if (!grantableBy(inviterRole).includes(wantedRole)) {
    return `A ${inviterRole.toLowerCase()} cannot make somebody an owner. An owner has to do that.`;
  }
  return null;
}

/** One address, one way of writing it. */
export function cleanEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  /* Deliberately not a full RFC 5322 parser — that rejects addresses that
     work. This catches the shapes that are certainly not addresses. */
  if (!email || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

/** LIVE, ACCEPTED, REVOKED or EXPIRED — computed, never stored. */
export function stateOf(invite, now = new Date()) {
  if (!invite) return "MISSING";
  if (invite.acceptedAt) return "ACCEPTED";
  if (invite.revokedAt) return "REVOKED";
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "LIVE";
}

/**
 * What a browser may see about an invitation.
 *
 * NO TOKEN, and no hash either. The plaintext is returned once by the endpoint
 * that creates it and never again; anything that reads an invitation back gets
 * this shape, so there is no field for a link to leak through.
 */
export function toWire(invite, now = new Date()) {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    state: stateOf(invite, now),
    expiresAt: invite.expiresAt,
    acceptedAt: invite.acceptedAt || null,
    revokedAt: invite.revokedAt || null,
    createdAt: invite.createdAt,
    invitedBy: invite.invitedBy
      ? { name: invite.invitedBy.name || "", email: invite.invitedBy.email || "" }
      : null,
  };
}

/** The link an owner copies. Built from the public app URL, never guessed. */
export function inviteLink(appUrl, token) {
  return `${String(appUrl).replace(/\/+$/, "")}/auth/join.html?token=${encodeURIComponent(token)}`;
}

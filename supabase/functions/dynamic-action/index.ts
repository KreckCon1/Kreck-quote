// KRECK OS Edge Function "dynamic-action"
// (1) Build 10 "Camera Roll": talks to CompanyCam for the app (token lives ONLY in the COMPANYCAM_TOKEN secret).
// (2) Build 12 "Your Copy": emails the customer their signed-contract link (Resend key lives ONLY in the RESEND_API_KEY secret).
// (3) Build 13 prep (v9.5): "quote_send" emails the customer their proposal link to review and sign. Every quote email and every
// signed-contract email is BCC'd to everyone in OFFICES (Ti and Chris), and the recipient always comes from the customer record.
// (4) v9.7: the signed-contract email also carries a PDF of the signed contract (made by Browserless from the signed page; token lives
// ONLY in the BROWSERLESS_TOKEN secret). If the PDF step fails for any reason the email still goes out with the link only.
// CompanyCam actions, "signed_copy_send" and "quote_send" need a signed-in KRECK OS user. "signed_copy" is called by the customer page
// right after signing: it is checked against the database (the link must really be signed), sends at most once,
// and only ever emails the address already on the customer record - the caller cannot choose a recipient.
// (5) v9.8 Build 13 "Change orders": "co_send" (signed-in user) emails the customer a change-order link; "co_signed_copy"
// (customer page, by token) emails the signed change order with a PDF made from change.html. Same rules as contracts:
// recipient always from the customer record, office BCC'd, send-once claim, PDF failure never blocks the email.
const VERSION = "dynamic-action v9.8";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CC = "https://api.companycam.com/v2";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (obj) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (msg) => reply({ ok: false, error: msg });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COPY = 20;
const MAX_BYTES = 25 * 1024 * 1024;

async function cc(path, token) {
  const r = await fetch(CC + path, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (r.status === 401 || r.status === 403) throw new Error("CompanyCam rejected the access token. Check the COMPANYCAM_TOKEN secret.");
  if (r.status === 429) throw new Error("CompanyCam says slow down - try again in a minute.");
  if (!r.ok) throw new Error("CompanyCam error " + r.status);
  return await r.json();
}

function pickUri(photo, type) {
  const u = (photo.uris || []).find((x) => x.type === type);
  return u ? (u.uri || u.url || "") : "";
}

async function copyOne(admin, token, quoteId, photoId) {
  const photo = await cc("/photos/" + encodeURIComponent(photoId), token);
  // v9.2.1: take the full-size original (the app shrinks it on the iPad); fall back to "web" size
  const original = pickUri(photo, "original");
  const src = original || pickUri(photo, "web");
  if (!src) throw new Error("no image link on this photo");
  const isRaw = !!original; // raw- files are temporary; the app deletes them after shrinking
  let r = await fetch(src);
  if (r.status === 401 || r.status === 403) r = await fetch(src, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("image download failed (" + r.status + ")");
  const type = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  if (!type.startsWith("image/")) throw new Error("not an image");
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("photo too large");
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  const path = quoteId + "/" + (isRaw ? "raw-" : "cc") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + "." + ext;
  const up = await admin.storage.from("quote-photos").upload(path, buf, { contentType: type });
  if (up.error) throw new Error("storage: " + up.error.message);
  return Deno.env.get("SUPABASE_URL") + "/storage/v1/object/public/quote-photos/" + path;
}


// ---------- Build 12: signed copy ----------
const SITE = "https://quotes.kreckcontracting.com";
const FROM = "Kreck Contracting <ti@kreckcontracting.com>";
const OFFICE = "ti@kreckcontracting.com"; // reply-to address
// v9.5: everyone who gets a copy of every quote and every signed contract (BCC - customers never see these)
const OFFICES = ["ti@kreckcontracting.com", "chris.v@kreckcontracting.com"];
const bccFor = (customerEmail) => OFFICES.filter((a) => a.toLowerCase() !== String(customerEmail || "").toLowerCase());
const PHONE = "845-667-0586";
const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => { const v = Number(n); return isFinite(v) && v > 0 ? "$" + v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : ""; };
const longDate = (iso) => { try { return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" }); } catch (_) { return ""; } };
const looksLikeEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());

// ---------- v9.7: PDF of the signed contract ----------
const BL_HOST = "https://production-sfo.browserless.io";
const MAX_PDF = 15 * 1024 * 1024; // Resend allows 40MB total; stay well under
function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function blRequest(tokenKey, body, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(BL_HOST + "/pdf?token=" + encodeURIComponent(tokenKey), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal,
    });
    if (!r.ok) { let m = ""; try { m = (await r.text()).slice(0, 120); } catch (_) {} return { ok: false, why: "status " + r.status + " " + m }; }
    const buf = new Uint8Array(await r.arrayBuffer());
    const head = String.fromCharCode(buf[0] || 0, buf[1] || 0, buf[2] || 0, buf[3] || 0);
    if (head !== "%PDF") return { ok: false, why: "reply was not a PDF" };
    if (buf.length > MAX_PDF) return { ok: false, why: "PDF too large (" + buf.length + " bytes)" };
    return { ok: true, b64: toBase64(buf), bytes: buf.length };
  } catch (e) {
    return { ok: false, why: String(e && e.name === "AbortError" ? "timed out" : (e && e.message) || e).slice(0, 120) };
  } finally { clearTimeout(timer); }
}
// Never throws. Returns { ok, b64, bytes } or { ok:false, why }.
async function makeSignedPdf(shareToken, page) {
  const tk = Deno.env.get("BROWSERLESS_TOKEN");
  if (!tk) return { ok: false, why: "BROWSERLESS_TOKEN secret is not set" };
  const url = SITE + "/" + (page || "proposal.html") + "?t=" + encodeURIComponent(shareToken);
  const options = { printBackground: true, format: "Letter", margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" } };
  // try 1: wait until the signed banner has drawn; try 2 (if the service rejects those settings): plain wait
  let r = await blRequest(tk, { url, options, gotoOptions: { waitUntil: "networkidle2", timeout: 30000 }, waitForSelector: { selector: ".signedBanner", timeout: 20000 } }, 60000);
  if (!r.ok && /status 4\d\d/.test(r.why)) {
    r = await blRequest(tk, { url, options, gotoOptions: { waitUntil: "networkidle0", timeout: 30000 }, waitForTimeout: 4000 }, 60000);
  }
  return r;
}
const pdfName = (share) => "Kreck-Contracting-Signed-" + String(share.quote_number || share.job_type || "Contract").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) + ".pdf";

function buildEmail(share, cust, toCustomer, hasPdf) {
  const link = SITE + "/proposal.html?t=" + encodeURIComponent(share.token);
  const first = (cust && cust.first_name) || "";
  const who = share.customer_name || ((first + " " + ((cust && cust.last_name) || "")).trim()) || "Customer";
  const job = share.job_type || "project";
  const price = money(share.selected_price);
  const when = longDate(share.signed_at);
  const opt = share.selected_option || "";
  const lines = [];
  lines.push("Signed by: " + (share.signed_name || who) + (when ? " on " + when : ""));
  if (opt) lines.push("Selected: " + opt + (price ? " — " + price : ""));
  else if (price) lines.push("Total: " + price);
  if (share.quote_number) lines.push("Proposal: " + share.quote_number);
  let subject, intro, extra = "";
  if (toCustomer) {
    subject = "Your signed " + job + " contract — Kreck Contracting";
    intro = "Hi" + (first ? " " + first : "") + ", thank you for choosing Kreck Contracting. Your " + job.toLowerCase() + " proposal is signed and accepted. Here is your copy.";
    extra = hasPdf
      ? "Your signed contract is attached to this email as a PDF. Keep it for your records. The link below also always opens your signed contract online."
      : "Keep this email. The link below always opens your signed contract, and you can save it as a PDF from your phone or computer (use Share or Print, then Save as PDF).";
  } else {
    subject = "SIGNED — " + who + " — " + job + (price ? " " + price : "") + " (no customer email on file)";
    intro = who + " just signed. There is no email address on their record, so they did NOT get a copy." + (hasPdf ? " The signed PDF is attached here. Send it to them, or text them the link from the quote in KRECK OS." : " Text them this link from the quote in KRECK OS.");
  }
  const html =
    '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1a17">' +
    '<div style="background:#14110d;color:#fff;padding:18px 22px;font-size:18px;font-weight:800;letter-spacing:.04em">KRECK <span style="color:#e2711d">CONTRACTING</span></div>' +
    '<div style="padding:22px;border:1px solid #e6e1d8;border-top:none">' +
    '<p style="font-size:16px;line-height:1.5;margin:0 0 14px">' + esc(intro) + "</p>" +
    '<div style="background:#f6f2ea;border-radius:10px;padding:14px 16px;font-size:15px;line-height:1.6;margin:0 0 16px">' + lines.map(esc).join("<br>") + "</div>" +
    '<p style="margin:0 0 18px"><a href="' + esc(link) + '" style="display:inline-block;background:#e2711d;color:#fff;text-decoration:none;font-weight:800;padding:14px 22px;border-radius:10px;font-size:16px">View your signed contract</a></p>' +
    (extra ? '<p style="font-size:14px;line-height:1.5;color:#4b463d;margin:0 0 14px">' + esc(extra) + "</p>" : "") +
    '<p style="font-size:14px;color:#4b463d;margin:0">Questions? Call or text <b>' + PHONE + "</b> or just reply to this email.</p>" +
    '<p style="font-size:12px;color:#8a8478;margin:18px 0 0;word-break:break-all">Link: ' + esc(link) + "</p>" +
    "</div></div>";
  const text = intro + "\n\n" + lines.join("\n") + "\n\nView your signed contract: " + link + (extra ? "\n\n" + extra : "") + "\n\nQuestions? Call or text " + PHONE + " or reply to this email.";
  return { subject, html, text, link };
}

async function sendViaResend(key, payload, idemKey) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", "Idempotency-Key": idemKey },
    body: JSON.stringify(payload),
  });
  if (r.ok) return { ok: true };
  let msg = "";
  try { const j = await r.json(); msg = j.message || j.error || ""; } catch (_) {}
  return { ok: false, status: r.status, message: String(msg).slice(0, 200) };
}

// opts: { token } (customer page)  or  { quoteId, force:true } (signed-in app user)
async function signedCopy(admin, opts) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, error: "RESEND_API_KEY secret is not set in Supabase." };
  let q = admin.from("proposal_shares").select("*");
  q = opts.token
    ? q.eq("token", String(opts.token)).limit(1)
    : q.eq("quote_id", String(opts.quoteId)).not("signed_at", "is", null).order("signed_at", { ascending: false }).limit(1);
  const { data: rows, error: e1 } = await q;
  if (e1) return { ok: false, error: "lookup failed: " + e1.message };
  const share = rows && rows[0];
  if (!share) return { ok: false, error: "not found" };
  if (!share.signed_at) return { ok: false, error: "not signed" };

  if (!opts.force) {
    // claim it first, so two calls at once can never send twice
    const { data: claimed, error: eC } = await admin.from("proposal_shares")
      .update({ copy_sent_at: new Date().toISOString(), copy_sent_to: "sending" })
      .eq("token", share.token).is("copy_sent_at", null).select("token");
    if (eC) return { ok: false, error: "The Build 12 database update has not been run yet (" + eC.message + ")." };
    if (!claimed || !claimed.length) return { ok: true, already: true };
  }
  const release = async (why) => {
    if (!opts.force) await admin.from("proposal_shares").update({ copy_sent_at: null, copy_sent_to: "failed: " + why }).eq("token", share.token);
  };
  try {
    const { data: qr } = await admin.from("quotes")
      .select("id, jobs(customer_id, customers(first_name,last_name,email,phone))").eq("id", share.quote_id).maybeSingle();
    const cust = (qr && qr.jobs && qr.jobs.customers) || null;
    const email = cust && looksLikeEmail(cust.email) ? String(cust.email).trim() : null;
    const pdf = await makeSignedPdf(share.token); // never throws; on failure the email goes out with the link only
    const built = buildEmail(share, cust, !!email, pdf.ok);
    const payload = email
      ? { from: FROM, to: [email], bcc: bccFor(email), reply_to: OFFICE, subject: built.subject, html: built.html, text: built.text }
      : { from: FROM, to: OFFICES, reply_to: OFFICE, subject: built.subject, html: built.html, text: built.text };
    if (pdf.ok) payload.attachments = [{ filename: pdfName(share), content: pdf.b64 }];
    else console.error("signed PDF not attached: " + pdf.why);
    const idem = "signed-copy-" + share.token + (opts.force ? "-" + Date.now().toString(36) : "");
    const res = await sendViaResend(key, payload, idem);
    if (!res.ok) {
      const why = res.status + (res.message ? " " + res.message : "");
      await release(why);
      return { ok: false, error: "Email not sent (" + why + "). If it says the domain is not verified, finish the Resend domain setup." };
    }
    await admin.from("proposal_shares").update({ copy_sent_at: new Date().toISOString(), copy_sent_to: email || "office only" }).eq("token", share.token);
    return { ok: true, customer_emailed: !!email, sent_to: email || "office only", link: built.link, pdf_attached: !!pdf.ok, pdf_note: pdf.ok ? null : pdf.why };
  } catch (e) {
    await release(String(e && e.message ? e.message : e).slice(0, 120));
    return { ok: false, error: "Email failed: " + String(e && e.message ? e.message : e) };
  }
}

// ---------- v9.5: quote email ----------
function buildQuoteEmail(share, cust) {
  const link = SITE + "/proposal.html?t=" + encodeURIComponent(share.token);
  const first = (cust && cust.first_name) || "";
  const job = share.job_type || "project";
  const subject = "Your " + job + " proposal from Kreck Contracting";
  const intro = "Hi" + (first ? " " + first : "") + ", thank you for the opportunity. Your " + job.toLowerCase() + " proposal from Kreck Contracting is ready. Tap the button to review it and sign online.";
  const note = "This link is good for 30 days. If you have questions, or want anything changed before you sign, just reply to this email or call us.";
  const ref = share.quote_number ? "Proposal: " + share.quote_number : "";
  const html =
    '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1a17">' +
    '<div style="background:#14110d;color:#fff;padding:18px 22px;font-size:18px;font-weight:800;letter-spacing:.04em">KRECK <span style="color:#e2711d">CONTRACTING</span></div>' +
    '<div style="padding:22px;border:1px solid #e6e1d8;border-top:none">' +
    '<p style="font-size:16px;line-height:1.5;margin:0 0 14px">' + esc(intro) + "</p>" +
    (ref ? '<div style="background:#f6f2ea;border-radius:10px;padding:12px 16px;font-size:15px;margin:0 0 16px">' + esc(ref) + "</div>" : "") +
    '<p style="margin:0 0 18px"><a href="' + esc(link) + '" style="display:inline-block;background:#e2711d;color:#fff;text-decoration:none;font-weight:800;padding:14px 22px;border-radius:10px;font-size:16px">Review and sign your proposal</a></p>' +
    '<p style="font-size:14px;line-height:1.5;color:#4b463d;margin:0 0 14px">' + esc(note) + "</p>" +
    '<p style="font-size:14px;color:#4b463d;margin:0">Call or text <b>' + PHONE + "</b> or reply to this email.</p>" +
    '<p style="font-size:12px;color:#8a8478;margin:18px 0 0;word-break:break-all">Link: ' + esc(link) + "</p>" +
    "</div></div>";
  const text = intro + (ref ? "\n\n" + ref : "") + "\n\nReview and sign your proposal: " + link + "\n\n" + note + "\n\nCall or text " + PHONE + " or reply to this email.";
  return { subject, html, text, link };
}

// opts: { token } - a signed-in KRECK OS user asks for the proposal link to be emailed. The recipient comes from the customer
// record in the database, never from the caller. A proposal that is already signed is refused (the signed-copy email covers that).
async function quoteSend(admin, opts) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, error: "RESEND_API_KEY secret is not set in Supabase." };
  const { data: rows, error: e1 } = await admin.from("proposal_shares").select("*").eq("token", String(opts.token)).limit(1);
  if (e1) return { ok: false, error: "lookup failed: " + e1.message };
  const share = rows && rows[0];
  if (!share) return { ok: false, error: "not found" };
  if (share.signed_at) return { ok: false, error: "This proposal is already signed." };
  try {
    const { data: qr } = await admin.from("quotes")
      .select("id, jobs(customer_id, customers(first_name,last_name,email,phone))").eq("id", share.quote_id).maybeSingle();
    const cust = (qr && qr.jobs && qr.jobs.customers) || null;
    const email = cust && looksLikeEmail(cust.email) ? String(cust.email).trim() : null;
    if (!email) return { ok: false, no_email: true, error: "No customer email on file." };
    const built = buildQuoteEmail(share, cust);
    const payload = { from: FROM, to: [email], bcc: bccFor(email), reply_to: OFFICE, subject: built.subject, html: built.html, text: built.text };
    const res = await sendViaResend(key, payload, "quote-send-" + share.token + "-" + Date.now().toString(36));
    if (!res.ok) {
      const why = res.status + (res.message ? " " + res.message : "");
      return { ok: false, error: "Email not sent (" + why + ")." };
    }
    return { ok: true, sent_to: email, link: built.link };
  } catch (e) {
    return { ok: false, error: "Email failed: " + String(e && e.message ? e.message : e) };
  }
}

// ---------- v9.8 Build 13: change orders ----------
const moneySigned = (n) => { const v = Number(n); if (!isFinite(v)) return ""; return (v < 0 ? "−" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const coPdfName = (co) => "Kreck-Contracting-Signed-" + String(co.co_number || "Change-Order").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 48) + ".pdf";

async function coCustomer(admin, co) {
  const { data: qr } = await admin.from("quotes")
    .select("id, quote_number, jobs(customer_id, job_type, customers(first_name,last_name,email,phone))").eq("id", co.quote_id).maybeSingle();
  const cust = (qr && qr.jobs && qr.jobs.customers) || null;
  return { cust, job: (qr && qr.jobs && qr.jobs.job_type) || "project", quoteNumber: (qr && qr.quote_number) || "" };
}

function coShell(intro, box, btnText, link, extra) {
  const html =
    '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1a17">' +
    '<div style="background:#14110d;color:#fff;padding:18px 22px;font-size:18px;font-weight:800;letter-spacing:.04em">KRECK <span style="color:#e2711d">CONTRACTING</span></div>' +
    '<div style="padding:22px;border:1px solid #e6e1d8;border-top:none">' +
    '<p style="font-size:16px;line-height:1.5;margin:0 0 14px">' + esc(intro) + "</p>" +
    (box.length ? '<div style="background:#f6f2ea;border-radius:10px;padding:14px 16px;font-size:15px;line-height:1.6;margin:0 0 16px">' + box.map(esc).join("<br>") + "</div>" : "") +
    '<p style="margin:0 0 18px"><a href="' + esc(link) + '" style="display:inline-block;background:#e2711d;color:#fff;text-decoration:none;font-weight:800;padding:14px 22px;border-radius:10px;font-size:16px">' + esc(btnText) + "</a></p>" +
    (extra ? '<p style="font-size:14px;line-height:1.5;color:#4b463d;margin:0 0 14px">' + esc(extra) + "</p>" : "") +
    '<p style="font-size:14px;color:#4b463d;margin:0">Questions? Call or text <b>' + PHONE + "</b> or just reply to this email.</p>" +
    '<p style="font-size:12px;color:#8a8478;margin:18px 0 0;word-break:break-all">Link: ' + esc(link) + "</p>" +
    "</div></div>";
  const text = intro + (box.length ? "\n\n" + box.join("\n") : "") + "\n\n" + btnText + ": " + link + (extra ? "\n\n" + extra : "") + "\n\nQuestions? Call or text " + PHONE + " or reply to this email.";
  return { html, text };
}

// opts: { coId } - a signed-in KRECK OS user asks for the change-order link to be emailed to the customer on record.
async function coSend(admin, opts) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, error: "RESEND_API_KEY secret is not set in Supabase." };
  const { data: co, error: e1 } = await admin.from("change_orders").select("*").eq("id", String(opts.coId)).maybeSingle();
  if (e1) return { ok: false, error: "lookup failed: " + e1.message };
  if (!co) return { ok: false, error: "not found" };
  if (co.status === "void") return { ok: false, error: "This change order is voided." };
  if (co.signed_at) return { ok: false, error: "This change order is already signed." };
  if (!co.token) return { ok: false, error: "This change order has no customer link." };
  try {
    const { cust, job, quoteNumber } = await coCustomer(admin, co);
    const email = cust && looksLikeEmail(cust.email) ? String(cust.email).trim() : null;
    if (!email) return { ok: false, no_email: true, error: "No customer email on file." };
    const link = SITE + "/change.html?t=" + encodeURIComponent(co.token);
    const first = (cust && cust.first_name) || "";
    const subject = "Change order " + (co.co_number || "") + " for your " + job + " — Kreck Contracting";
    const intro = "Hi" + (first ? " " + first : "") + ", here is a change order for your " + job.toLowerCase() + " from Kreck Contracting. Tap the button to read it and sign online. Nothing else in your contract changes.";
    const box = [];
    if (co.reason) box.push("Reason: " + co.reason);
    box.push("This change: " + moneySigned(co.change_total));
    if (co.new_contract_total != null) box.push("New contract total: " + moneySigned(co.new_contract_total));
    if (quoteNumber) box.push("Contract: " + quoteNumber);
    const built = coShell(intro, box, "Review and sign the change order", link, "This link is good for 30 days. If anything looks off, reply to this email or call us before you sign.");
    const payload = { from: FROM, to: [email], bcc: bccFor(email), reply_to: OFFICE, subject, html: built.html, text: built.text };
    const res = await sendViaResend(key, payload, "co-send-" + co.token + "-" + Date.now().toString(36));
    if (!res.ok) return { ok: false, error: "Email not sent (" + res.status + (res.message ? " " + res.message : "") + ")." };
    await admin.from("change_orders").update({ sent_to: email, sent_at: co.sent_at || new Date().toISOString() }).eq("id", co.id);
    return { ok: true, sent_to: email, link };
  } catch (e) {
    return { ok: false, error: "Email failed: " + String(e && e.message ? e.message : e) };
  }
}

// opts: { token } (customer page, right after signing). Sends at most once; PDF attached when Browserless delivers one.
async function coSignedCopy(admin, opts) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, error: "RESEND_API_KEY secret is not set in Supabase." };
  const { data: co, error: e1 } = await admin.from("change_orders").select("*").eq("token", String(opts.token)).maybeSingle();
  if (e1) return { ok: false, error: "lookup failed: " + e1.message };
  if (!co) return { ok: false, error: "not found" };
  if (!co.signed_at) return { ok: false, error: "not signed" };
  const { data: claimed, error: eC } = await admin.from("change_orders")
    .update({ copy_sent_at: new Date().toISOString(), copy_sent_to: "sending" })
    .eq("id", co.id).is("copy_sent_at", null).select("id");
  if (eC) return { ok: false, error: "claim failed: " + eC.message };
  if (!claimed || !claimed.length) return { ok: true, already: true };
  const release = async (why) => { await admin.from("change_orders").update({ copy_sent_at: null, copy_sent_to: "failed: " + why }).eq("id", co.id); };
  try {
    const { cust, job, quoteNumber } = await coCustomer(admin, co);
    const email = cust && looksLikeEmail(cust.email) ? String(cust.email).trim() : null;
    const pdf = await makeSignedPdf(co.token, "change.html");
    const link = SITE + "/change.html?t=" + encodeURIComponent(co.token);
    const first = (cust && cust.first_name) || "";
    const who = ((first + " " + ((cust && cust.last_name) || "")).trim()) || "Customer";
    const when = longDate(co.signed_at);
    const box = ["Signed by: " + (co.signed_name || who) + (when ? " on " + when : "")];
    if (co.reason) box.push("Reason: " + co.reason);
    box.push("This change: " + moneySigned(co.change_total));
    if (co.new_contract_total != null) box.push("New contract total: " + moneySigned(co.new_contract_total));
    box.push("Change order: " + (co.co_number || "") + (quoteNumber ? " to contract " + quoteNumber : ""));
    let subject, intro, extra;
    if (email) {
      subject = "Your signed change order " + (co.co_number || "") + " — Kreck Contracting";
      intro = "Hi" + (first ? " " + first : "") + ", thank you. Change order " + (co.co_number || "") + " for your " + job.toLowerCase() + " is signed and approved. Here is your copy.";
      extra = pdf.ok
        ? "Your signed change order is attached to this email as a PDF. Keep it with your contract. The link below also always opens it online."
        : "Keep this email. The link below always opens your signed change order, and you can save it as a PDF from your phone or computer (use Share or Print, then Save as PDF).";
    } else {
      subject = "SIGNED — change order " + (co.co_number || "") + " — " + who + " (no customer email on file)";
      intro = who + " just signed change order " + (co.co_number || "") + ". There is no email address on their record, so they did NOT get a copy." + (pdf.ok ? " The signed PDF is attached here. Send it to them, or text them the link from the quote in KRECK OS." : " Text them this link from the quote in KRECK OS.");
      extra = "";
    }
    const built = coShell(intro, box, "View your signed change order", link, extra);
    const payload = email
      ? { from: FROM, to: [email], bcc: bccFor(email), reply_to: OFFICE, subject, html: built.html, text: built.text }
      : { from: FROM, to: OFFICES, reply_to: OFFICE, subject, html: built.html, text: built.text };
    if (pdf.ok) payload.attachments = [{ filename: coPdfName(co), content: pdf.b64 }];
    else console.error("signed change-order PDF not attached: " + pdf.why);
    const res = await sendViaResend(key, payload, "co-signed-copy-" + co.token);
    if (!res.ok) {
      const why = res.status + (res.message ? " " + res.message : "");
      await release(why);
      return { ok: false, error: "Email not sent (" + why + ")." };
    }
    await admin.from("change_orders").update({ copy_sent_at: new Date().toISOString(), copy_sent_to: email || "office only" }).eq("id", co.id);
    return { ok: true, customer_emailed: !!email, sent_to: email || "office only", link, pdf_attached: !!pdf.ok, pdf_note: pdf.ok ? null : pdf.why };
  } catch (e) {
    await release(String(e && e.message ? e.message : e).slice(0, 120));
    return { ok: false, error: "Email failed: " + String(e && e.message ? e.message : e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    let body = {};
    try { body = await req.json(); } catch (_) { return fail("bad request"); }
    const admin = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

    // 0) Build 12: the customer page calls this right after signing. No sign-in, but it is checked against
    //    the database (the link must be signed), sends at most once, and only to the address on file.
    if (body.action === "signed_copy") {
      if (!/^[0-9a-f]{20,80}$/i.test(String(body.token || ""))) return fail("bad token");
      return reply(await signedCopy(admin, { token: body.token }));
    }
    // v9.8: the change-order customer page, right after signing (same safeguards as signed_copy)
    if (body.action === "co_signed_copy") {
      if (!/^[0-9a-f]{20,80}$/i.test(String(body.token || ""))) return fail("bad token");
      return reply(await coSignedCopy(admin, { token: body.token }));
    }
    if (body.action === "version") return reply({ ok: true, version: VERSION });

    // 1) Signed-in KRECK OS user only
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u || !u.user) return fail("Not signed in. Sign in to KRECK OS and try again.");

    // Build 12: the "Send signed copy" button in the app (works even if the automatic send failed)
    if (body.action === "signed_copy_send") {
      const quoteId = String(body.quote_id || "");
      if (!UUID.test(quoteId)) return fail("bad quote id");
      return reply(await signedCopy(admin, { quoteId, force: true }));
    }

    // v9.5: email a proposal link to the customer (signed-in app users only)
    if (body.action === "quote_send") {
      if (!/^[0-9a-f]{20,80}$/i.test(String(body.token || ""))) return fail("bad token");
      return reply(await quoteSend(admin, { token: body.token }));
    }

    // v9.8: email a change-order link to the customer (signed-in app users only)
    if (body.action === "co_send") {
      const coId = String(body.co_id || "");
      if (!UUID.test(coId)) return fail("bad change order id");
      return reply(await coSend(admin, { coId }));
    }

    const token = Deno.env.get("COMPANYCAM_TOKEN");
    if (!token) return fail("COMPANYCAM_TOKEN secret is not set in Supabase.");

    // 2) Search projects
    if (body.action === "projects") {
      const q = String(body.query || "").trim().slice(0, 80);
      const data = await cc("/projects?per_page=25&status=active" + (q ? "&query=" + encodeURIComponent(q) : ""), token);
      const list = Array.isArray(data) ? data : [];
      return reply({
        ok: true,
        projects: list.map((p) => {
          const a = p.address || {};
          return {
            id: String(p.id),
            name: p.name || "",
            address: [a.street_address_1, a.city].filter(Boolean).join(", "),
            photo_count: typeof p.photo_count === "number" ? p.photo_count : null,
            updated: Number(p.updated_at || 0) || null,
          };
        }),
      });
    }

    // 3) List photos in a project, newest first
    if (body.action === "photos") {
      const pid = String(body.project_id || "");
      if (!/^\d{1,20}$/.test(pid)) return fail("bad project id");
      const data = await cc("/projects/" + pid + "/photos?per_page=60", token);
      const list = (Array.isArray(data) ? data : [])
        .filter((p) => !p.processing_status || p.processing_status === "processed")
        .map((p) => ({
          id: String(p.id),
          thumb: pickUri(p, "thumbnail") || pickUri(p, "web"),
          captured_at: Number(p.captured_at || 0),
        }))
        .sort((a, b) => b.captured_at - a.captured_at);
      return reply({ ok: true, photos: list });
    }

    // 4) Copy chosen photos into the quote-photos bucket (our copy, not a link)
    if (body.action === "copy") {
      const quoteId = String(body.quote_id || "");
      if (!UUID.test(quoteId)) return fail("bad quote id");
      const ids = (Array.isArray(body.photo_ids) ? body.photo_ids : []).map(String).filter((s) => /^\d{1,20}$/.test(s)).slice(0, MAX_COPY);
      if (!ids.length) return fail("no photos chosen");
      const results = [];
      for (let i = 0; i < ids.length; i += 2) { // 2 at a time (originals are big), order kept
        const chunk = ids.slice(i, i + 2);
        const out = await Promise.all(chunk.map((id) =>
          copyOne(admin, token, quoteId, id).then((url) => ({ url }), (e) => ({ error: String(e.message || e), id }))));
        results.push(...out);
      }
      return reply({
        ok: true,
        urls: results.filter((r) => r.url).map((r) => r.url),
        failed: results.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })),
      });
    }

    return fail("unknown action");
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
});
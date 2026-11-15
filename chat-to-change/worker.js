// WebBrew chat-to-change: one Worker per client site, configured by client.json.
// Static site files are served as assets. This Worker handles the private /chat-to-change page and /api/*
// (both behind Cloudflare Access), adds scheduled specials to the specials page, and sends the monthly summary.
//
// Changes a client makes (new photo, new special, new article) become a GitHub pull request plus an approval message to the
// admins (Telegram, through the WebBrew hub, and/or email) with before/after pictures and Approve / Reject buttons. Free-text requests
// become GitHub issues.
import { EmailMessage } from "cloudflare:email";
import CLIENT from "./client.json";
import SPECIALS from "./specials.json";
import PAGE from "./page.html";
import WEBBREW_LOGO from "./webbrew-logo.png";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const LABEL = "chat-to-change";
const PAGES = CLIENT.pages;
const WEBBREW_MARK = `<footer class="webbrew"><span>Website care by</span><img src="/c2c-assets/webbrew.png" alt="WebBrew"></footer>`;
const MAX_PHOTO = 3_000_000; // base64 characters, about 2.2 MB
const MAX_ATTACHMENTS = 3;
const MONTHLY_CRON = "0 5 1 * *"; // the separate monthly cron older sites still have (before 1.7.0)
const READY = "awaiting-approval", ANNOUNCED = "announced"; // labels on pull requests Claude prepares
const ALL_WAITING = `<a href="https://${CLIENT.domain}/api/approvals">Everything waiting for approval</a>`; // line at the end of Telegram approval messages
const SIGNIN_PARAM = "signin"; // added to the address after clearing a stale login, so it happens only once
const CLEAR_LOGIN = "CF_Authorization=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"; // Cloudflare Access's login cookie
const ATTACH_BRANCH = "chat-to-change-attachments"; // screenshots sent with requests; never merged into main
const MAX_ARTICLE = 12000; // characters of article text
// Where articles go. Older client.json files have no "articles" block, so every field has a default.
const ARTICLES = {
  path: "/articles/", // the list of articles; each article is at <path><slug>/
  heading: "Articles",
  template: `${CLIENT.siteDir}/index.html`, // a plain page of the site whose header, footer and styles articles reuse
  content: "main", // CSS selector of that page's content area, which the article replaces
  file: "chat-to-change/articles.json",
  ...CLIENT.articles,
};

const INSTRUCTIONS = `You help the owner of the ${CLIENT.name} website (${CLIENT.domain}) turn a change they want into a clear request for the person who edits the site.
The site's pages: ${PAGES.join(", ")}.
Photos, specials and articles have their own buttons on this page ("Change a photo", "Add a special", "Add an article"); if they want one of those, tell them to use that button.
They can attach screenshots or pictures to a request. You can't see them, but they are sent along with it, so don't ask them to describe a picture they've attached; you may suggest a screenshot when it would make a request clearer.
Be brief and warm, plain English, no jargon. Never claim the change is made; it is only being prepared.
Act on a sensible reading of what they asked. Ask a question (one short question, ready false) only when something you need is truly missing: which page, the exact new wording, a price, hours or dates, or whether to remove or replace something. If they give a link to a page of the site, the page is known: don't ask which page.
Don't ask them to confirm what you understood: when ready is true, the page shows your summary with an "Approve" button, and they can approve it or tell you what to adjust. When they adjust it, give the whole updated summary again.
Reply with only JSON: {"reply": "<what you say>", "ready": true or false, "page": "<one page name from the list>", "summary": "<one clear sentence (or two for two changes) describing every change they asked for, with the exact wording, prices or hours to use, and mentioning any attached pictures>"}.
When ready is true, keep reply to one short sentence.`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/c2c-assets/webbrew.png") return new Response(WEBBREW_LOGO, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
    if (path === CLIENT.specials.page) return withSpecials(await env.ASSETS.fetch(request));
    const isPage = path === "/chat-to-change" || path === "/chat-to-change/";
    if (!isPage && !path.startsWith("/api/")) return env.ASSETS.fetch(request);

    // The login only covers the client's main address, so send www. visitors there.
    if (url.hostname === `www.${CLIENT.domain}`) {
      url.hostname = CLIENT.domain;
      return Response.redirect(url.toString(), 301);
    }

    // A login the browser still holds but that no longer checks out (expired, or signed with a retired key) is
    // cleared, so Cloudflare Access asks the person to sign in again instead of the page looking signed in.
    const login = await accessLogin(request, env);
    if (!login) {
      const signedIn = url.searchParams.has(SIGNIN_PARAM); // we already sent them to sign in once: don't loop
      if (request.method === "GET" && !signedIn && (isPage || (request.headers.get("Accept") || "").includes("text/html"))) {
        url.searchParams.set(SIGNIN_PARAM, "1");
        return new Response(null, { status: 302, headers: { Location: url.pathname + url.search, "Set-Cookie": CLEAR_LOGIN, "Cache-Control": "no-store" } });
      }
      if (isPage) return page();
      return json({ error: "Your sign-in has run out. Please sign in again.", signedOut: true }, 401, { "Set-Cookie": CLEAR_LOGIN });
    }
    if (isPage) return page();
    const viewer = login.email;
    const listed = (list) => (list || []).some((e) => String(e).toLowerCase() === viewer.toLowerCase());
    const admin = listed(CLIENT.admins);
    // One Access login can cover every WebBrew site, so each site only lets in its own people.
    if (!admin && !listed(CLIENT.clients)) {
      console.log(`login refused: ${viewer} is not in client.json admins or clients`);
      if (isPage || (request.headers.get("Accept") || "").includes("text/html")) {
        return htmlPage("Not allowed", `<p>${esc(viewer)} can't make changes to this website. If that's a mistake, please contact WebBrew.</p>`, 403);
      }
      return json({ error: "This email can't make changes to this website." }, 403);
    }

    try {
      const route = `${request.method} ${path}`;
      if (route === "GET /api/me") return me(viewer, admin, login.exp);
      if (route === "GET /api/telegram") return admin ? await telegramSetup(url, env) : htmlPage("Not allowed", "<p>Only WebBrew can open this page.</p>", 403);
      if (route === "POST /api/chat") return await chat(request, env);
      if (route === "GET /api/tickets") return await listTickets(env);
      if (route === "POST /api/tickets") return await createTicket(request, env, viewer);
      if (route === "POST /api/photo") return await newPhoto(request, env, viewer);
      if (route === "POST /api/special") return await newSpecial(request, env, viewer);
      if (route === "POST /api/article") return await newArticle(request, env, viewer);
      const reply = path.match(/^\/api\/tickets\/(\d+)\/reply$/);
      if (reply && request.method === "POST") return await replyToTicket(request, env, viewer, reply[1]);

      // Admin pages: the list of changes waiting for approval, and the pages opened from Telegram and the approval email.
      if (path === "/api/approvals" || path === "/api/review" || path === "/api/undo") {
        if (!admin) return htmlPage("Not allowed", "<p>Only WebBrew can open this page.</p>", 403);
        if (path === "/api/approvals") return await approvalsPage(url, env);
        if (path === "/api/review") return request.method === "POST" ? await reviewAction(request, env, viewer) : await reviewPage(url, env);
        return request.method === "POST" ? await undoAction(request, env, viewer) : await undoPage(env);
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      if (path === "/api/approvals" || path === "/api/review" || path === "/api/undo") return htmlPage("Something went wrong", `<p>${esc(err.message)}</p>`, 500);
      return json({ error: "Something went wrong. Please try again in a minute." }, 500);
    }
  },

  // One cron trigger in wrangler.jsonc, every 15 minutes (a Cloudflare free account allows only 5 cron triggers in all,
  // so each site uses one). Each run checks for changes waiting for approval; the run at 05:00 UTC on the 1st also
  // sends the monthly summary. A site that still has the separate monthly cron from before 1.7.0 should remove it
  // (see CHANGELOG), or it gets the summary twice.
  async scheduled(event, env, ctx) {
    if (event.cron === MONTHLY_CRON) return void ctx.waitUntil(monthlySummary(env));
    const t = new Date(event.scheduledTime);
    const monthlyDue = t.getUTCDate() === 1 && t.getUTCHours() === 5 && t.getUTCMinutes() < 15;
    ctx.waitUntil(Promise.all([announceReadyChanges(env), monthlyDue ? monthlySummary(env) : null]));
  },
};

// ---------- Page and specials ----------

function page() {
  const t = CLIENT.theme;
  const fill = {
    NAME: esc(CLIENT.name), EDITOR: esc(CLIENT.editor), DOMAIN: esc(CLIENT.domain), LOGO: esc(t.logo), FAVICON: esc(t.favicon), FONTS_URL: esc(t.fontsUrl),
    DISPLAY: t.display, BODY: t.body, BG: t.bg, LINE: t.line, MUTED: t.muted, ACCENT: t.accent, ACCENT_INK: t.accentInk, ACCENT_SOFT: t.accentSoft,
    WEBBREW: CLIENT.webbrewMark ? WEBBREW_MARK : "",
  };
  const html = PAGE.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CLIENT.timezone }).format(new Date()); // YYYY-MM-DD
}

function specialStatus(s, day = today()) {
  if (day < s.from) return "scheduled";
  if (day > s.to) return "ended";
  return "live";
}

function withSpecials(response) {
  const live = SPECIALS.filter((s) => specialStatus(s) === "live");
  if (!live.length || !(response.headers.get("Content-Type") || "").includes("text/html")) return response;
  const out = new HTMLRewriter()
    .on(CLIENT.specials.insertAfter, { element(el) { el.after(specialsHtml(live), { html: true }); } })
    .transform(response);
  out.headers.set("Cache-Control", "no-cache");
  return out;
}

function specialsHtml(list) {
  const t = CLIENT.theme;
  const cards = list.map((s) => `
    <article class="c2c-special">
      ${s.image ? `<img src="/${esc(s.image)}" alt="${esc(s.alt || s.title)}" loading="lazy">` : ""}
      <div class="c2c-special-body">
        <h2>${esc(s.title)}</h2>
        <p>${esc(s.text).replace(/\n/g, "<br>")}</p>
        <p class="c2c-until">Until ${esc(longDate(s.to))}</p>
      </div>
    </article>`).join("");
  return `<div class="c2c-specials">
  <style>
    .c2c-specials{max-width:1080px;margin:30px auto;padding:0 16px;display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
    .c2c-special{background:#fff;border:1px solid ${t.line};display:grid;align-content:start}
    .c2c-special img{width:100%;height:auto;display:block}
    .c2c-special-body{padding:18px 20px}
    .c2c-special h2{font-family:${t.display};font-weight:300;color:${t.accent};font-size:28px;line-height:1.2;margin:0 0 8px;padding:0}
    .c2c-special p{margin:0 0 8px;padding:0}
    .c2c-until{font-size:14px;color:${t.muted}}
  </style>${cards}
</div>`;
}

function longDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

// ---------- API: who am I, chat, tickets ----------

function me(viewer, admin, expires) {
  const day = today();
  return json({
    email: viewer,
    admin,
    expires, // seconds since 1970; the page sends the person to sign in once this has passed
    slots: CLIENT.slots.map(({ id, label, page, file, width, height }) => ({ id, label, page, url: `/${file}`, width, height })),
    specials: SPECIALS.map((s) => ({ ...s, status: specialStatus(s, day) })),
  });
}

async function chat(request, env) {
  const { messages } = await request.json();
  const turns = (Array.isArray(messages) ? messages : [])
    .slice(-12)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "Nothing to answer." }, 400);

  const out = await env.AI.run(MODEL, {
    messages: [{ role: "system", content: INSTRUCTIONS }, ...turns],
    max_tokens: 400,
    temperature: 0.3,
  });
  const parsed = parseJson(out.response);
  if (!parsed || typeof parsed.reply !== "string") {
    return json({ reply: String(out.response || "Sorry, could you say that another way?"), ready: false });
  }
  return json({
    reply: parsed.reply,
    ready: Boolean(parsed.ready && parsed.summary),
    page: linkedPage(turns) || (PAGES.includes(parsed.page) ? parsed.page : "Not sure"),
    summary: String(parsed.summary || ""),
  });
}

// The last link to a page of this site that the client typed, as a path ("/meiryo-buy-1-get-1/"). Exact, so it wins over
// the AI's guess from the page list.
function linkedPage(turns) {
  const domain = CLIENT.domain.replace(/^www\./, "").replace(/\./g, "\\.");
  const re = new RegExp(`(?<![\\w@.-])(?:https?://)?(?:www\\.)?${domain}(/[^\\s"'<>)]*)?`, "gi");
  let path = "";
  for (const t of turns) if (t.role === "user") for (const m of t.content.matchAll(re)) if (m[1]) path = m[1];
  if (!path) return "";
  path = path.split(/[?#]/)[0].replace(/[.,;:!]+$/, "") || "/";
  return path.length > 1 && !path.endsWith("/") && !path.includes(".") ? path + "/" : path;
}

async function createTicket(request, env, viewer) {
  const body = await request.json();
  const summary = clean(body.summary, 500);
  if (!summary) return json({ error: "Please describe the change first." }, 400);
  const page = PAGES.includes(body.page) || /^\/[^\s<>"]{0,200}$/.test(body.page || "") ? body.page : "Not sure";
  const original = clean(body.original, 4000) || summary;
  const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_ATTACHMENTS).map(base64Only);
  // The page sends every picture as a JPEG it has already resized.
  if (images.some((b64) => !b64.startsWith("/9j/") || b64.length > MAX_PHOTO)) return json({ error: "One of the pictures couldn't be used. Please remove it and try again." }, 400);
  // A request is never lost because its pictures couldn't be saved; the issue says so instead.
  const links = images.length ? await saveAttachments(env, images).catch((err) => (console.error("attachments failed", err), null)) : [];

  const issue = await github(env, `/repos/${CLIENT.repo}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: summary.slice(0, 120),
      labels: [LABEL],
      body: [
        `**Page:** ${page}`,
        `**Change:** ${summary}`,
        "",
        "**In their words:**",
        ...original.split("\n").map((l) => `> ${l}`),
        "",
        ...(links === null ? [`**Pictures:** ${images.length} sent, but they couldn't be saved. Please ask for them again.`, ""] : []),
        ...(links?.length ? ["**Pictures:**", "", ...links.map((url, i) => `![Picture ${i + 1}](${url})`), ""] : []),
        `_Sent from ${CLIENT.domain}/chat-to-change by ${viewer}._`,
      ].join("\n"),
    }),
  });

  // The ticket is saved even if the alert email fails.
  await sendEmail(env, CLIENT.admins, {
    subject: `${CLIENT.name}: request #${issue.number}: ${summary.slice(0, 60)}`,
    images: images.map((base64, i) => ({ cid: `pic${i + 1}`, base64 })),
    html: emailHtml(`New request from ${esc(viewer)}`, `
      <p><b>Page:</b> ${esc(page)}<br><b>Change:</b> ${esc(summary)}</p>
      ${images.map((_, i) => `<p><img src="cid:pic${i + 1}" width="520" style="width:100%;max-width:520px;height:auto;border:1px solid #ddd"></p>`).join("")}
      <p>To get it done now, open the project in Claude and say: <b>do website ticket #${issue.number}</b></p>`),
  }).catch((err) => console.error("alert email failed", err));
  await tellStaff(env, [
    `🆕 <b>${esc(CLIENT.name)}</b>: request #${issue.number} from ${esc(viewer)}`,
    `<b>Page:</b> ${esc(page)}`,
    esc(summary),
  ].join("\n"), {
    buttons: [{ text: "Open the request", url: issue.html_url }],
    images: images.map((base64, i) => ({ base64, caption: `Picture ${i + 1}` })),
  });
  return json({ number: issue.number });
}

async function listTickets(env) {
  const items = await github(env, `/repos/${CLIENT.repo}/issues?labels=${LABEL}&state=all&per_page=20&sort=created&direction=desc`);
  const tickets = await Promise.all(items.map(async (i) => {
    const labels = i.labels.map((l) => l.name);
    let note = "";
    if (i.comments > 0) {
      const comments = await github(env, `/repos/${CLIENT.repo}/issues/${i.number}/comments?per_page=100`);
      const last = comments[comments.length - 1];
      note = last ? stripFooter(last.body) : "";
    }
    return { number: i.number, title: i.title, createdAt: i.created_at, updatedAt: i.updated_at, status: ticketStatus(i, labels), note };
  }));
  return json({ tickets });
}

async function replyToTicket(request, env, viewer, number) {
  const text = clean((await request.json()).text, 2000);
  if (!text) return json({ error: "Please write an answer first." }, 400);
  await github(env, `/repos/${CLIENT.repo}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: `**Answer from ${viewer}:**\n\n${text}` }),
  });
  await github(env, `/repos/${CLIENT.repo}/issues/${number}/labels/question`, { method: "DELETE" }).catch(() => {});
  return json({ ok: true });
}

function ticketStatus(item, labels) {
  if (item.pull_request) {
    if (item.pull_request.merged_at) return "done";
    return item.state === "closed" ? "cancelled" : "review";
  }
  if (item.state === "closed") return item.state_reason === "not_planned" ? "cancelled" : "done";
  if (labels.includes("question")) return "question";
  if (labels.includes("awaiting-approval")) return "review";
  if (labels.includes("in-progress")) return "working";
  return "queued";
}

// ---------- API: new photo ----------

async function newPhoto(request, env, viewer) {
  const body = await request.json();
  const slot = CLIENT.slots.find((s) => s.id === body.slot);
  if (!slot) return json({ error: "Please pick which photo to replace." }, 400);
  const image = base64Only(body.image);
  if (!image || image.length > MAX_PHOTO) return json({ error: "That photo is too large. Please try a smaller one." }, 400);
  const note = clean(body.note, 500);

  const alt = clean(body.alt, 200) || (await describePhoto(env, base64Only(body.thumb))) || slot.label;
  const stamp = new Date();
  const newFile = `wp-content/uploads/${stamp.getUTCFullYear()}/${String(stamp.getUTCMonth() + 1).padStart(2, "0")}/${slot.id}-${stamp.getTime().toString(36)}.jpg`;

  const files = [{ path: `${CLIENT.siteDir}/${newFile}`, base64: image }];
  for (const htmlPath of slot.files) {
    const html = await readFile(env, htmlPath);
    files.push({ path: htmlPath, text: swapImage(html, slot.file, newFile, alt) });
  }
  // Point the slot at the new file so the next swap replaces this one.
  const config = JSON.parse(await readFile(env, "chat-to-change/client.json"));
  config.slots.find((s) => s.id === slot.id).file = newFile;
  files.push({ path: "chat-to-change/client.json", text: JSON.stringify(config, null, 2) + "\n" });

  const title = `New photo: ${slot.label}`;
  const pr = await openChange(env, {
    title,
    files,
    body: [`**Photo:** ${slot.label}`, `**Was:** \`${slot.file}\``, `**Now:** \`${newFile}\``, `**Description:** ${alt}`, `**Preview page:** ${slot.page}`, note ? `**Note:** ${note}` : "", "", `_Sent from ${CLIENT.domain}/chat-to-change by ${viewer}._`].filter(Boolean).join("\n"),
  });

  const images = [];
  if (body.before) images.push({ cid: "before", base64: base64Only(body.before) });
  if (body.thumb) images.push({ cid: "after", base64: base64Only(body.thumb) });
  await approvalEmail(env, pr, viewer, title, `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
      <td width="50%" valign="top" style="padding:0 6px 0 0"><p style="margin:0 0 6px;font-size:13px;color:#666">Before</p>${body.before ? `<img src="cid:before" width="260" style="width:100%;max-width:260px;height:auto;display:block;border:1px solid #ddd">` : "<p>(no picture)</p>"}</td>
      <td width="50%" valign="top" style="padding:0 0 0 6px"><p style="margin:0 0 6px;font-size:13px;color:#666">After</p><img src="cid:after" width="260" style="width:100%;max-width:260px;height:auto;display:block;border:1px solid #ddd"></td>
    </tr></table>
    <p><b>Where:</b> ${esc(slot.label)}<br><b>Description for Google and screen readers:</b> ${esc(alt)}${note ? `<br><b>Note:</b> ${esc(note)}` : ""}</p>`,
    slot.page, images);
  return json({ number: pr.number });
}

// Replaces every reference to the old photo (including WordPress size variants like -980x653) in one HTML file,
// and drops srcset/sizes on those <img> tags since the variants no longer exist for the new photo.
function swapImage(html, oldFile, newFile, alt) {
  const dot = oldFile.lastIndexOf(".");
  const stem = oldFile.slice(0, dot), ext = oldFile.slice(dot + 1);
  const re = new RegExp(`((?:\\.\\./)*/?)${escRe(stem)}(?:-\\d+x\\d+)?\\.${escRe(ext)}`, "g");
  return html
    .replace(re, (m, prefix) => prefix + newFile)
    .replace(/<img\b[^>]*>/g, (tag) => {
      if (!tag.includes(newFile)) return tag;
      return tag.replace(/\s(?:srcset|sizes)="[^"]*"/g, "").replace(/\salt="[^"]*"/, ` alt="${esc(alt)}"`);
    });
}

async function describePhoto(env, thumb) {
  if (!thumb) return "";
  try {
    const out = await env.AI.run(VISION_MODEL, {
      image: [...Uint8Array.from(atob(thumb), (c) => c.charCodeAt(0))],
      prompt: `Describe this photo for the ${CLIENT.name} website in one short sentence, for alt text. No "image of".`,
      max_tokens: 60,
    });
    return clean(out.description, 200).replace(/^["']|["']$/g, "");
  } catch (err) {
    console.error("alt text failed", err);
    return "";
  }
}

// ---------- API: new special ----------

async function newSpecial(request, env, viewer) {
  const body = await request.json();
  const title = clean(body.title, 80), text = clean(body.text, 600);
  const from = clean(body.from, 10), to = clean(body.to, 10);
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!title || !text) return json({ error: "Please add a heading and the details." }, 400);
  if (!isDate(from) || !isDate(to) || to < from) return json({ error: "Please check the start and end dates." }, 400);
  if (to < today()) return json({ error: "That end date has already passed." }, 400);

  const special = { id: Date.now().toString(36), title, text, from, to };
  const files = [];
  const image = base64Only(body.image);
  if (image) {
    if (image.length > MAX_PHOTO) return json({ error: "That photo is too large. Please try a smaller one." }, 400);
    const d = new Date();
    special.image = `wp-content/uploads/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/special-${special.id}.jpg`;
    special.alt = (await describePhoto(env, base64Only(body.thumb))) || title;
    files.push({ path: `${CLIENT.siteDir}/${special.image}`, base64: image });
  }
  const list = JSON.parse(await readFile(env, CLIENT.specials.file));
  // Tidy up: drop specials that ended more than 60 days ago.
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const kept = list.filter((s) => s.to >= cutoff);
  kept.push(special);
  files.push({ path: CLIENT.specials.file, text: JSON.stringify(kept, null, 2) + "\n" });

  const prTitle = `New special: ${title} (${from} to ${to})`;
  const pr = await openChange(env, {
    title: prTitle,
    files,
    body: [`**Special:** ${title}`, `**Shows:** ${from} to ${to} on ${CLIENT.specials.page}`, `**Preview page:** ${CLIENT.specials.page}`, "", text, "", `_Sent from ${CLIENT.domain}/chat-to-change by ${viewer}._`].join("\n"),
  });

  const t = CLIENT.theme;
  await approvalEmail(env, pr, viewer, prTitle, `
    <p>It will show on the Specials page from <b>${esc(longDate(from))}</b> to <b>${esc(longDate(to))}</b>, and disappear by itself afterwards.</p>
    <div style="border:1px solid ${t.line};max-width:340px;background:#fff">
      ${image && body.thumb ? `<img src="cid:after" width="340" style="width:100%;height:auto;display:block">` : ""}
      <div style="padding:14px 16px">
        <div style="font-family:Georgia,serif;color:${t.accent};font-size:24px;line-height:1.2;margin-bottom:6px">${esc(title)}</div>
        <div style="margin-bottom:6px">${esc(text).replace(/\n/g, "<br>")}</div>
        <div style="font-size:13px;color:${t.muted}">Until ${esc(longDate(to))}</div>
      </div>
    </div>`,
    CLIENT.specials.page, image && body.thumb ? [{ cid: "after", base64: base64Only(body.thumb) }] : []);
  return json({ number: pr.number });
}

// ---------- API: new article ----------
// The client's text becomes a page of the site: the template page's header, footer and styles around a title,
// pictures and paragraphs in the site's fonts. Workers AI only lays the text out (paragraphs, subheadings, a title
// if none was given); if it changes any of the client's words, the Worker lays it out itself instead.

const ARTICLE_INSTRUCTIONS = `You lay out an article for the ${CLIENT.name} website (${CLIENT.domain}).
Split the owner's text into paragraphs, and use short subheadings only where the text clearly has them. Keep every word exactly as written, in the same order: never add, remove, reword or correct anything.
If no title is given: when the text's first line is clearly its title, use that line as the title and leave it out of the paragraphs; otherwise write a short title of at most 10 words.
Reply with only JSON: {"title": "<the title>", "description": "<one sentence of at most 155 characters about the article, for Google>", "blocks": [{"type": "p" or "h2", "text": "<paragraph or subheading>"}]}`;

async function newArticle(request, env, viewer) {
  const body = await request.json();
  const given = clean(body.title, 120).replace(/\s+/g, " ");
  const text = clean(body.text, MAX_ARTICLE).replace(/\r\n?/g, "\n");
  if (text.length < 40) return json({ error: "Please write or paste the article first." }, 400);
  const pictures = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_ATTACHMENTS)
    .map((p) => ({ image: base64Only(p && p.image), thumb: base64Only(p && p.thumb) }));
  if (pictures.some((p) => !p.image.startsWith("/9j/") || p.image.length > MAX_PHOTO)) return json({ error: "One of the pictures couldn't be used. Please remove it and try again." }, 400);

  const laid = await layoutArticle(env, given, text);
  const list = JSON.parse(await readFile(env, ARTICLES.file).catch((err) => { if (/: 404$/.test(err.message)) return "[]"; throw err; }));
  let slug = slugify(laid.title);
  for (let n = 2; list.some((a) => a.slug === slug); n++) slug = `${slugify(laid.title)}-${n}`;
  const url = `${ARTICLES.path}${slug}/`;

  const d = new Date();
  const dir = `wp-content/uploads/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const files = [];
  const images = await Promise.all(pictures.map(async (p, i) => {
    const file = `${dir}/article-${slug}-${i + 1}.jpg`;
    files.push({ path: `${CLIENT.siteDir}/${file}`, base64: p.image });
    return { file, alt: (await describePhoto(env, p.thumb)) || laid.title };
  }));

  const article = { slug, title: laid.title, date: today(), description: laid.description, ...(images[0] ? { image: images[0].file, alt: images[0].alt } : {}) };
  const template = await readFile(env, ARTICLES.template).catch((err) => (console.error("article template", err), ""));
  files.push({ path: `${CLIENT.siteDir}${url}index.html`, text: await sitePage(template, { title: laid.title, description: laid.description, url, image: article.image, inner: articleHtml(article, laid.blocks, images) }) });
  const all = [article, ...list];
  files.push({ path: `${CLIENT.siteDir}${ARTICLES.path}index.html`, text: await sitePage(template, { title: ARTICLES.heading, description: `${ARTICLES.heading} from ${CLIENT.name}.`, url: ARTICLES.path, inner: articleListHtml(all) }) });
  files.push({ path: ARTICLES.file, text: JSON.stringify(all, null, 2) + "\n" });

  const prTitle = `New article: ${laid.title}`;
  const pr = await openChange(env, {
    title: prTitle,
    files,
    body: [`**Article:** ${laid.title}`, `**Page:** ${url}`, `**Preview page:** ${url}`, `**Pictures:** ${images.length}`, laid.checked ? "" : "_Laid out without AI (the AI layout changed some words)._", "", ...text.split("\n").map((l) => `> ${l}`), "", `_Sent from ${CLIENT.domain}/chat-to-change by ${viewer}._`].join("\n"),
  });

  const t = CLIENT.theme;
  const paras = laid.blocks.filter((b) => b.type === "p");
  await approvalEmail(env, pr, viewer, prTitle, `
    <p>A new page at <b>${esc(CLIENT.domain)}${esc(url)}</b>, also listed on ${esc(ARTICLES.path)}.</p>
    <div style="border:1px solid ${t.line};max-width:520px;background:#fff;padding:16px">
      <div style="font-family:Georgia,serif;color:${t.accent};font-size:26px;line-height:1.2;margin-bottom:10px">${esc(laid.title)}</div>
      ${pictures[0]?.thumb ? `<img src="cid:pic1" width="488" style="width:100%;height:auto;display:block;margin-bottom:10px">` : ""}
      ${paras.slice(0, 2).map((b) => `<p style="margin:0 0 10px">${esc(b.text)}</p>`).join("")}
      ${paras.length > 2 ? `<p style="margin:0;color:${t.muted};font-size:13px">…and ${paras.length - 2} more paragraph${paras.length > 3 ? "s" : ""}${images.length > 1 ? `, ${images.length} pictures` : ""}.</p>` : ""}
    </div>`,
    url, pictures.filter((p) => p.thumb).map((p, i) => ({ cid: `pic${i + 1}`, base64: p.thumb, caption: `Picture ${i + 1}` })));
  return json({ number: pr.number, url });
}

// Returns { title, description, blocks: [{ type: "p" | "h2", text }], checked } where checked means the AI's layout kept
// the client's words exactly.
async function layoutArticle(env, given, text) {
  let ai = null;
  try {
    const out = await env.AI.run(MODEL, {
      messages: [{ role: "system", content: ARTICLE_INSTRUCTIONS }, { role: "user", content: `${given ? `Title (keep it as it is): ${given}` : "No title given."}\n\nText:\n${text}` }],
      max_tokens: 4096,
      temperature: 0.1,
    });
    ai = parseJson(out.response);
  } catch (err) {
    console.error("article layout failed", err);
  }
  const title = given || clean(ai?.title, 120).replace(/\s+/g, " ").replace(/^["']|["']$/g, "");
  const description = clean(ai?.description, 200);
  const blocks = (Array.isArray(ai?.blocks) ? ai.blocks : [])
    .map((b) => ({ type: b && b.type === "h2" ? "h2" : "p", text: clean(b && b.text, MAX_ARTICLE).replace(/\s+/g, " ") }))
    .filter((b) => b.text);
  const words = (s) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") || "";
  const said = words(text), laidOut = words(blocks.map((b) => b.text).join(" "));
  const checked = Boolean(blocks.length) && (laidOut === said || (!given && words(`${title} ${laidOut}`) === said));
  if (checked && title) return { title, description: description || firstWords((blocks.find((b) => b.type === "p") || blocks[0]).text, 155), blocks, checked };

  // Laid out by the Worker: blank lines (or, if there are none, line breaks) separate paragraphs; a short line
  // with no full stop, followed by more text, is a subheading.
  const heading = (s) => s.length <= 80 && s.split(" ").length <= 12 && !/[.!?,;:]$/.test(s);
  const parts = text.split(/\n\s*\n/.test(text) ? /\n\s*\n/ : /\n/).flatMap((part) => {
    const lines = part.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.length > 1 && heading(lines[0]) ? [lines[0], lines.slice(1).join(" ")] : [lines.join(" ")];
  }).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  const sentence = (s) => (s.match(/^.{10,80}?[.!?](?=\s|$)/)?.[0] || firstWords(s, 60)).replace(/[.]$/, "");
  const own = given || (parts.length > 1 && heading(parts[0]) ? parts.shift() : title || sentence(parts[0]));
  const fallback = parts.map((s, i) => ({ type: i < parts.length - 1 && heading(s) ? "h2" : "p", text: s }));
  return { title: own, description: description || firstWords(fallback.find((b) => b.type === "p")?.text || own, 155), blocks: fallback, checked: false };
}

function firstWords(s, max) {
  s = String(s || "");
  return s.length <= max ? s : s.slice(0, s.lastIndexOf(" ", max - 1) > 0 ? s.lastIndexOf(" ", max - 1) : max - 1) + "…";
}

function slugify(s) {
  return s.normalize("NFKD").toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 60).replace(/-+$/, "") || "article";
}

// The first picture goes under the title; the others are spread out between the paragraphs.
function articleHtml(article, blocks, images) {
  const t = CLIENT.theme;
  const pic = (img) => `<figure class="c2c-pic"><img src="/${esc(img.file)}" alt="${esc(img.alt)}" loading="lazy"></figure>`;
  const rest = images.slice(1);
  const after = new Map(rest.map((img, i) => [Math.max(0, Math.ceil(((i + 1) * blocks.length) / (rest.length + 1)) - 1), img]));
  const body = blocks.map((b, i) => `<${b.type}>${esc(b.text)}</${b.type}>${after.has(i) ? pic(after.get(i)) : ""}`).join("\n      ");
  return `<div class="c2c-article">
  <style>
    .c2c-article{max-width:760px;margin:0 auto;padding:48px 20px 56px;font-family:${t.body};font-size:18px;line-height:1.75;color:#212121}
    .c2c-article h1{font-family:${t.display};font-weight:300;color:${t.accent};font-size:clamp(32px,6vw,46px);line-height:1.15;margin:0 0 10px;padding:0}
    .c2c-article h2{font-family:${t.display};font-weight:400;color:${t.accentInk};font-size:clamp(24px,4vw,30px);line-height:1.25;margin:1.6em 0 .5em;padding:0}
    .c2c-article p{margin:0 0 1.2em;padding:0;font-size:inherit;line-height:inherit}
    .c2c-article .c2c-date{font-size:14px;letter-spacing:1px;text-transform:uppercase;color:${t.muted};margin:0 0 28px}
    .c2c-article .c2c-pic{margin:0 0 1.6em;padding:0}
    .c2c-article .c2c-pic img{width:100%;height:auto;display:block}
    .c2c-article .c2c-more{margin-top:2em;font-size:15px}
    .c2c-article .c2c-more a{color:${t.accentInk}}
  </style>
  <article>
    <h1>${esc(article.title)}</h1>
    <p class="c2c-date">${esc(longDate(article.date))}</p>
    ${images[0] ? pic(images[0]) : ""}
    <div class="c2c-body">
      ${body}
    </div>
  </article>
  <p class="c2c-more"><a href="${esc(ARTICLES.path)}">More ${esc(ARTICLES.heading.toLowerCase())}</a></p>
</div>`;
}

function articleListHtml(list) {
  const t = CLIENT.theme;
  const cards = list.map((a) => `
    <article class="c2c-card">
      ${a.image ? `<a href="${esc(ARTICLES.path + a.slug)}/"><img src="/${esc(a.image)}" alt="${esc(a.alt || a.title)}" loading="lazy"></a>` : ""}
      <div>
        <h2><a href="${esc(ARTICLES.path + a.slug)}/">${esc(a.title)}</a></h2>
        <p class="c2c-date">${esc(longDate(a.date))}</p>
        <p>${esc(a.description)}</p>
      </div>
    </article>`).join("");
  return `<div class="c2c-articles">
  <style>
    .c2c-articles{max-width:1080px;margin:0 auto;padding:48px 20px 56px;font-family:${t.body};line-height:1.6;color:#212121}
    .c2c-articles h1{font-family:${t.display};font-weight:300;color:${t.accent};font-size:clamp(32px,6vw,46px);line-height:1.15;margin:0 0 28px;padding:0}
    .c2c-list{display:grid;gap:24px;align-items:start;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
    .c2c-card{background:#fff;border:1px solid ${t.line};display:grid;align-content:start}
    .c2c-card img{width:100%;aspect-ratio:3/2;object-fit:cover;display:block}
    .c2c-card div{padding:18px 20px}
    .c2c-card h2{font-family:${t.display};font-weight:300;font-size:26px;line-height:1.2;margin:0 0 6px;padding:0}
    .c2c-card h2 a{color:${t.accent};text-decoration:none}
    .c2c-card p{margin:0 0 8px;padding:0}
    .c2c-card .c2c-date{font-size:13px;letter-spacing:1px;text-transform:uppercase;color:${t.muted}}
  </style>
  <h1>${esc(ARTICLES.heading)}</h1>
  <div class="c2c-list">${cards}</div>
</div>`;
}

// Puts content into a copy of the template page, so it has the site's own menu, footer, fonts and styles. The
// template's relative links keep working through a <base> pointing at its folder. Without a usable template,
// it makes a simple page in the client's theme instead.
async function sitePage(template, { title, description, url, image, inner }) {
  const t = CLIENT.theme;
  const full = `${title} | ${CLIENT.name}`;
  const head = `<meta name="description" content="${esc(description)}"><link rel="canonical" href="https://${esc(CLIENT.domain)}${esc(url)}">
<meta property="og:type" content="article"><meta property="og:title" content="${esc(full)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="https://${esc(CLIENT.domain)}${esc(url)}">${image ? `<meta property="og:image" content="https://${esc(CLIENT.domain)}/${esc(image)}">` : ""}`;
  if (template) {
    const folder = "/" + ARTICLES.template.slice(CLIENT.siteDir.length).replace(/^\/+/, "").replace(/[^/]*$/, "");
    let placed = false;
    const drop = { element(el) { el.remove(); } };
    const out = await new HTMLRewriter()
      .on("head", { element(el) { el.prepend(`<base href="${esc(folder)}">`, { html: true }); el.append(head, { html: true }); } })
      .on("title", { element(el) { el.setInnerContent(full); } })
      .on('meta[name="description"]', drop).on('link[rel="canonical"]', drop).on('meta[property^="og:"]', drop)
      .on('meta[name^="twitter:"]', drop).on('script[type="application/ld+json"]', drop)
      .on('a[href^="#"]', { element(el) { el.setAttribute("href", url + el.getAttribute("href")); } }) // or <base> would send them to the template page
      .on(".current-menu-item", { element(el) { el.setAttribute("class", el.getAttribute("class").replace(/\bcurrent[-_]\S+/g, "").trim()); } })
      .on(ARTICLES.content, { element(el) { if (placed) return; placed = true; el.setInnerContent(inner, { html: true }); } })
      .transform(new Response(template)).text();
    if (placed) return out;
    console.error(`article template: "${ARTICLES.content}" not found in ${ARTICLES.template}`);
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>${head}<link rel="icon" href="${esc(t.favicon)}"><link rel="stylesheet" href="${esc(t.fontsUrl)}">
<style>body{margin:0;background:${t.bg}}header{max-width:1080px;margin:0 auto;padding:20px}header img{width:160px;height:auto}main{background:#fff}</style></head>
<body><header><a href="/"><img src="${esc(t.logo)}" alt="${esc(CLIENT.name)}"></a></header><main>${inner}</main></body></html>
`;
}

// Commits a request's pictures to their own branch (created from main on first use) and returns links that
// show them in the GitHub issue to anyone with access to the repo. One commit per request.
async function saveAttachments(env, images) {
  const repo = `/repos/${CLIENT.repo}`;
  let head = await github(env, `${repo}/git/ref/heads/${ATTACH_BRANCH}`).catch(() => null);
  if (!head) {
    const main = await github(env, `${repo}/git/ref/heads/main`);
    head = await github(env, `${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${ATTACH_BRANCH}`, sha: main.object.sha }) });
  }
  const base = await github(env, `${repo}/git/commits/${head.object.sha}`);
  const stamp = new Date();
  const dir = `attachments/${stamp.toISOString().slice(0, 7)}`;
  const id = stamp.getTime().toString(36);
  const tree = await Promise.all(images.map(async (content, i) => {
    const blob = await github(env, `${repo}/git/blobs`, { method: "POST", body: JSON.stringify({ content, encoding: "base64" }) });
    return { path: `${dir}/${id}-${i + 1}.jpg`, mode: "100644", type: "blob", sha: blob.sha };
  }));
  const newTree = await github(env, `${repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
  const commit = await github(env, `${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: "Pictures for a chat-to-change request", tree: newTree.sha, parents: [head.object.sha] }),
  });
  await github(env, `${repo}/git/refs/heads/${ATTACH_BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
  return tree.map((t) => `https://github.com/${CLIENT.repo}/blob/${commit.sha}/${t.path}?raw=true`);
}

// ---------- Changes as pull requests ----------

async function openChange(env, { title, files, body }) {
  const repo = `/repos/${CLIENT.repo}`;
  const head = await github(env, `${repo}/git/ref/heads/main`);
  const base = await github(env, `${repo}/git/commits/${head.object.sha}`);
  const tree = await Promise.all(files.map(async (f) => {
    const blob = await github(env, `${repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify(f.base64 ? { content: f.base64, encoding: "base64" } : { content: f.text, encoding: "utf-8" }),
    });
    return { path: f.path, mode: "100644", type: "blob", sha: blob.sha };
  }));
  const newTree = await github(env, `${repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
  const commit = await github(env, `${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: `${title}\n\nPrepared by chat-to-change.`, tree: newTree.sha, parents: [head.object.sha] }),
  });
  const branch = `c2c-${Date.now().toString(36)}`;
  await github(env, `${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
  const pr = await github(env, `${repo}/pulls`, { method: "POST", body: JSON.stringify({ title, head: branch, base: "main", body }) });
  await github(env, `${repo}/issues/${pr.number}/labels`, { method: "POST", body: JSON.stringify({ labels: [LABEL] }) }).catch(() => {});
  return { number: pr.number, branch };
}

// Cloudflare names a branch's preview after the branch in lower case, with anything but letters and digits as "-".
function previewUrl(branch, page) {
  return `https://${branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${CLIENT.previewHost}${page}`;
}

async function approvalEmail(env, pr, viewer, title, details, page, images) {
  const link = await reviewLink(env, pr.number);
  await tellStaff(env, `✅ <b>${esc(CLIENT.name)}</b>: ready to approve (#${pr.number})\n${esc(title)}\n<i>Sent by ${esc(viewer)}</i>\n${ALL_WAITING}`, {
    buttons: reviewButtons(link, previewUrl(pr.branch, page)),
    images: images.map((img) => ({ base64: img.base64, caption: img.caption || (img.cid === "before" ? "Before" : "After") })),
  });
  await sendEmail(env, CLIENT.admins, {
    subject: `Approve? ${CLIENT.name}: ${title}`,
    images,
    html: emailHtml(`${esc(viewer)} sent a change for ${esc(CLIENT.domain)}`, `
      <p style="font-size:18px;margin:0 0 12px"><b>${esc(title)}</b></p>
      ${details}
      <p style="margin:18px 0 8px"><a href="${previewUrl(pr.branch, page)}">See the whole page with this change</a> (ready about a minute after this email)</p>
      <p style="margin:18px 0">${button(link + "&do=approve", "Approve and publish", true)} &nbsp; ${button(link + "&do=reject", "Reject", false)}</p>
      <p style="font-size:13px;color:#666">Nothing changes on the live site until you approve.</p>`),
  }).catch((err) => console.error("approval email failed", err));
}

async function reviewLink(env, number) {
  return `https://${CLIENT.domain}/api/review?pr=${number}&t=${await sign(env, `review:${number}`)}`;
}

function reviewButtons(link, preview) {
  return [{ text: "Approve", url: `${link}&do=approve` }, { text: "Reject", url: `${link}&do=reject` }, { text: "Preview", url: preview }];
}

// Changes prepared outside the Worker (by Claude) are pull requests labelled awaiting-approval. Each one is announced
// once, with the same Approve / Reject buttons, and then labelled "announced".
async function announceReadyChanges(env) {
  if (!telegramReady(env)) return;
  const repo = `/repos/${CLIENT.repo}`;
  const items = await github(env, `${repo}/issues?labels=${READY}&state=open&per_page=20`);
  for (const item of items) {
    if (!item.pull_request || item.labels.some((l) => l.name === ANNOUNCED)) continue;
    const pr = await github(env, `${repo}/pulls/${item.number}`);
    const page = previewPage(pr);
    const sent = await tellStaff(env, `✅ <b>${esc(CLIENT.name)}</b>: ready to approve (#${pr.number})\n${esc(pr.title)}\n${ALL_WAITING}`, {
      buttons: [...reviewButtons(await reviewLink(env, pr.number), previewUrl(pr.head.ref, page)), { text: "Details", url: pr.html_url }],
    });
    if (sent) await github(env, `${repo}/issues/${pr.number}/labels`, { method: "POST", body: JSON.stringify({ labels: [ANNOUNCED] }) });
  }
}

// Everything waiting for approval on one page, for admins only: changes made on the page (label chat-to-change) and
// changes Claude prepared (label awaiting-approval). Each has Approve and Reject buttons that post to /api/review.
async function approvalsPage(url, env) {
  const repo = `/repos/${CLIENT.repo}`;
  const [pulls, issues] = await Promise.all([
    github(env, `${repo}/pulls?state=open&sort=created&direction=asc&per_page=50`),
    github(env, `${repo}/issues?labels=${LABEL}&state=open&sort=created&direction=asc&per_page=50`),
  ]);
  const waiting = pulls.filter((pr) => !pr.draft && pr.labels.some((l) => l.name === LABEL || l.name === READY));
  const requests = issues.filter((i) => !i.pull_request);
  const when = (iso) => new Date(iso).toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: CLIENT.timezone });
  const cards = await Promise.all(waiting.map(async (pr) => {
    const t = await sign(env, `review:${pr.number}`);
    const from = (pr.body || "").match(/_Sent from \S+ by (\S+?)\._\s*$/m)?.[1];
    const button = (action, label, primary) => `<form method="post" action="/api/review" onsubmit="return confirm('${action === "approve" ? "Publish this change on the live site?" : "Reject this change?"}')"><input type="hidden" name="pr" value="${pr.number}"><input type="hidden" name="t" value="${t}"><input type="hidden" name="back" value="approvals"><button name="do" value="${action}"${primary ? ' class="primary"' : ""}>${label}</button></form>`;
    return `<div class="item">
      <p><b>${esc(pr.title)}</b><br><span class="muted">#${pr.number} · ${esc(when(pr.created_at))}${from ? ` · from ${esc(from)}` : " · prepared by Claude"}</span></p>
      <p class="muted"><a href="${previewUrl(pr.head.ref, previewPage(pr))}" target="_blank" rel="noopener">Preview</a> · <a href="${esc(pr.html_url)}" target="_blank" rel="noopener">Details</a></p>
      <div class="buttons">${button("approve", "Approve and publish", true)}${button("reject", "Reject", false)}</div>
    </div>`;
  }));
  const list = cards.length ? cards.join("") : "<p>Nothing is waiting for approval.</p>";
  const asked = requests.length
    ? `<h2>Requests still being prepared</h2><p class="muted">These were sent from the Chat to change tab and don't have a change to approve yet.</p><ul>${requests.map((i) => `<li><a href="${esc(i.html_url)}" target="_blank" rel="noopener">#${i.number}</a> ${esc(i.title)} <span class="muted">(${esc(when(i.created_at))})</span></li>`).join("")}</ul>`
    : "";
  const published = url.searchParams.get("published"), rejected = url.searchParams.get("rejected");
  const done = /^\d+$/.test(published || "") ? `<p class="done">#${published} is published. It shows on ${esc(CLIENT.domain)} in about a minute. ${undoLink().replace(/<\/?p[^>]*>/g, "")}</p>`
    : /^\d+$/.test(rejected || "") ? `<p class="done">#${rejected} is rejected and won't be published.</p>` : "";
  return htmlPage(waiting.length ? `Waiting for approval (${waiting.length})` : "Waiting for approval", `${done}
    <p class="muted">Nothing below is on the live site until you approve it. Approve publishes it in about a minute.</p>
    ${list}${asked}`);
}

function previewPage(pr) {
  return (pr.body || "").match(/^\*\*Preview page:\*\*\s*(\/\S*)/m)?.[1] || "/";
}

async function reviewPage(url, env) {
  const n = url.searchParams.get("pr"), t = url.searchParams.get("t");
  if (!/^\d+$/.test(n || "") || t !== (await sign(env, `review:${n}`))) return htmlPage("Link not valid", "<p>This approval link isn't valid.</p>", 400);
  const pr = await github(env, `/repos/${CLIENT.repo}/pulls/${n}`);
  if (pr.merged) return htmlPage("Already published", `<p><b>${esc(pr.title)}</b> is already live.</p>${undoLink()}`);
  if (pr.state === "closed") return htmlPage("Already rejected", `<p><b>${esc(pr.title)}</b> was rejected earlier.</p>`);
  const approve = url.searchParams.get("do") !== "reject";
  // Emails can be opened by link scanners, so the change only happens when this button is pressed.
  return htmlPage(approve ? "Publish this change?" : "Reject this change?", `
    <p><b>${esc(pr.title)}</b></p>
    <form method="post">
      <input type="hidden" name="pr" value="${n}"><input type="hidden" name="t" value="${t}">
      <button name="do" value="${approve ? "approve" : "reject"}" class="${approve ? "primary" : ""}">${approve ? "Yes, publish it" : "Yes, reject it"}</button>
    </form>
    <p class="muted"><a href="${previewUrl(pr.head.ref, previewPage(pr))}">Open the preview</a></p>${approvalsLink()}`);
}

async function reviewAction(request, env, viewer) {
  const form = await request.formData();
  const n = String(form.get("pr") || ""), t = form.get("t"), action = form.get("do");
  // From the approvals list, go straight back to it so the next change can be approved.
  const back = form.get("back") === "approvals" ? (done) => new Response(null, { status: 303, headers: { Location: `/api/approvals?${done}=${n}` } }) : null;
  if (!/^\d+$/.test(n) || t !== (await sign(env, `review:${n}`))) return htmlPage("Link not valid", "<p>This approval link isn't valid.</p>", 400);
  const repo = `/repos/${CLIENT.repo}`;
  const pr = await github(env, `${repo}/pulls/${n}`);
  if (pr.merged || pr.state === "closed") return htmlPage("Already done", `<p><b>${esc(pr.title)}</b> was already ${pr.merged ? "published" : "rejected"}.</p>${approvalsLink()}`);

  if (action === "reject") {
    await github(env, `${repo}/issues/${n}/comments`, { method: "POST", body: JSON.stringify({ body: `Rejected by ${viewer}.` }) });
    await github(env, `${repo}/pulls/${n}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
    await github(env, `${repo}/git/refs/heads/${pr.head.ref}`, { method: "DELETE" }).catch(() => {});
    if (back) return back("rejected");
    return htmlPage("Rejected", `<p><b>${esc(pr.title)}</b> won't be published.</p>${approvalsLink()}`);
  }
  const res = await githubFetch(env, `${repo}/pulls/${n}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: "squash", commit_title: `${pr.title} (#${n})`, commit_message: `Approved by ${viewer}.` }),
  });
  if (!res.ok) {
    console.error("merge failed", res.status, await res.text());
    return htmlPage("Couldn't publish", `<p><b>${esc(pr.title)}</b> clashes with a newer change. Please reject it and send it again.</p>${approvalsLink()}`, 409);
  }
  await github(env, `${repo}/git/refs/heads/${pr.head.ref}`, { method: "DELETE" }).catch(() => {});
  if (back) return back("published");
  return htmlPage("Published", `<p><b>${esc(pr.title)}</b> is going live now. It shows on ${esc(CLIENT.domain)} in about a minute.</p>${undoLink()}${approvalsLink()}`);
}

// ---------- Undo the last change ----------

function approvalsLink() {
  return `<p class="muted"><a href="/api/approvals">See everything waiting for approval</a></p>`;
}

function undoLink() {
  return `<p class="muted">Changed your mind? <a href="/api/undo">Undo the last change</a></p>`;
}

async function lastChange(env) {
  const repo = `/repos/${CLIENT.repo}`;
  const head = await github(env, `${repo}/git/ref/heads/main`);
  const commit = await github(env, `${repo}/git/commits/${head.object.sha}`);
  return { sha: head.object.sha, title: commit.message.split("\n")[0], date: commit.author.date, parent: commit.parents[0] };
}

async function undoPage(env) {
  const last = await lastChange(env);
  if (!last.parent) return htmlPage("Nothing to undo", "<p>There's no earlier version to go back to.</p>");
  return htmlPage("Undo the last change?", `
    <p>The last change to ${esc(CLIENT.domain)} was:</p>
    <p><b>${esc(last.title)}</b><br><span class="muted">${esc(new Date(last.date).toLocaleString("en-ZA", { timeZone: CLIENT.timezone }))}</span></p>
    <form method="post">
      <input type="hidden" name="sha" value="${last.sha}"><input type="hidden" name="t" value="${await sign(env, `undo:${last.sha}`)}">
      <button class="primary">Yes, undo it</button>
    </form>`);
}

async function undoAction(request, env, viewer) {
  const form = await request.formData();
  const sha = String(form.get("sha") || "");
  if (form.get("t") !== (await sign(env, `undo:${sha}`))) return htmlPage("Link not valid", "<p>Please open the undo page again.</p>", 400);
  const last = await lastChange(env);
  if (last.sha !== sha) return htmlPage("Something changed", `<p>A newer change went live in the meantime. <a href="/api/undo">Look again</a>.</p>`, 409);
  const repo = `/repos/${CLIENT.repo}`;
  const parent = await github(env, `${repo}/git/commits/${last.parent.sha}`);
  const commit = await github(env, `${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: `Undo: ${last.title}\n\nUndone by ${viewer} with chat-to-change.`, tree: parent.tree.sha, parents: [sha] }),
  });
  await github(env, `${repo}/git/refs/heads/main`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
  return htmlPage("Undone", `<p><b>${esc(last.title)}</b> has been undone. The site goes back in about a minute.</p>`);
}

// ---------- Monthly summary ----------

async function monthlySummary(env) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const month = start.toLocaleDateString("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" });
  const items = await github(env, `/repos/${CLIENT.repo}/issues?labels=${LABEL}&state=closed&since=${start.toISOString()}&per_page=100`);
  const done = items.filter((i) => {
    const closed = new Date(i.closed_at);
    return closed >= start && closed < end && (i.pull_request ? i.pull_request.merged_at : i.state_reason !== "not_planned");
  });
  const live = SPECIALS.filter((s) => specialStatus(s) !== "ended");
  const rows = done.length
    ? `<ul>${done.map((i) => `<li>${esc(i.title)} <span style="color:#666">(${esc(new Date(i.closed_at).toLocaleDateString("en-ZA", { day: "numeric", month: "short", timeZone: CLIENT.timezone }))})</span></li>`).join("")}</ul>`
    : "<p>No changes were made this month.</p>";
  const specials = live.length
    ? `<p><b>Specials running or coming up:</b></p><ul>${live.map((s) => `<li>${esc(s.title)}: ${esc(longDate(s.from))} to ${esc(longDate(s.to))}</li>`).join("")}</ul>`
    : "";
  await sendEmail(env, [...CLIENT.admins, ...CLIENT.clients], {
    subject: `${CLIENT.name} website: ${month} summary`,
    html: emailHtml(`Your website in ${esc(month)}`, `
      <p>Here's what changed on ${esc(CLIENT.domain)} last month:</p>${rows}${specials}
      <p>Need something else changed? <a href="https://${CLIENT.domain}/chat-to-change">Open your website changes page</a>.</p>`),
  });
}

// ---------- Telegram ----------
// Alerts go through the WebBrew Telegram hub (hub/ in the chat-to-change repo), a Worker that holds the one WebBrew
// bot's token and the chat that gets every site's alerts. A site reaches it through the service binding TELEGRAM_HUB
// in wrangler.jsonc, so it needs no bot token or chat ID of its own. Every message names the site.
// Older setups still work: without the binding, the Worker secret TELEGRAM_BOT_TOKEN and client.json telegramChat
// are used directly. client.json telegramChat, if set, also sends this site's alerts to a different chat via the hub.
// Buttons are links, so the bot needs no webhook. A failed message is logged and never fails the client's request.

function telegramReady(env) {
  return Boolean(env.TELEGRAM_HUB || (env.TELEGRAM_BOT_TOKEN && CLIENT.telegramChat));
}

async function telegram(env, method, body) {
  const init = body instanceof FormData
    ? { method: "POST", body }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = env.TELEGRAM_HUB
    ? await env.TELEGRAM_HUB.fetch(`https://hub/${method}`, init)
    : await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, init);
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${res.status} ${data.description || ""}`);
  return data.result;
}

// Sends pictures (if any) and then the message with its buttons. Returns true if the message was sent.
// With the hub, an empty chat means the hub's own chat.
async function tellStaff(env, html, { buttons = [], images = [], chat = CLIENT.telegramChat } = {}) {
  if (!telegramReady(env) || (!env.TELEGRAM_HUB && !chat)) return false;
  try {
    const photos = images.filter((img) => img.base64);
    if (photos.length) {
      const form = new FormData();
      if (chat) form.append("chat_id", String(chat));
      const caption = (img) => [CLIENT.name, img.caption].filter(Boolean).join(": ");
      photos.forEach((img, i) => form.append(`p${i}`, new Blob([b64bytes(img.base64)], { type: "image/jpeg" }), `p${i}.jpg`));
      if (photos.length === 1) {
        form.set("photo", form.get("p0"));
        form.delete("p0");
        form.append("caption", caption(photos[0]));
        await telegram(env, "sendPhoto", form);
      } else {
        form.append("media", JSON.stringify(photos.map((img, i) => ({ type: "photo", media: `attach://p${i}`, caption: caption(img) }))));
        await telegram(env, "sendMediaGroup", form);
      }
    }
    await telegram(env, "sendMessage", {
      ...(chat ? { chat_id: chat } : {}),
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(buttons.length ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
    });
    return true;
  } catch (err) {
    console.error("telegram failed", err);
    return false;
  }
}

// Admin page for setting up: says where this site's alerts go, lists the chats the bot has seen recently (groups and
// private chats, with their IDs) and sends a test message to one. A private chat ID sends alerts to that person only.
async function telegramSetup(url, env) {
  const hubSteps = "<p>Connect this site to the WebBrew Telegram hub: its <code>wrangler.jsonc</code> needs <code>\"services\": [{ \"binding\": \"TELEGRAM_HUB\", \"service\": \"webbrew-telegram\" }]</code>.</p>";
  if (!env.TELEGRAM_HUB && !env.TELEGRAM_BOT_TOKEN) return htmlPage("Telegram not set up", hubSteps);
  const hub = env.TELEGRAM_HUB ? await env.TELEGRAM_HUB.fetch("https://hub/status").then((r) => r.json()).catch(() => null) : null;
  if (env.TELEGRAM_HUB && !hub?.token) {
    return htmlPage("Telegram not set up", "<p>This site is connected to the WebBrew Telegram hub, but the hub has no bot token yet. In Cloudflare open <b>Workers &amp; Pages → webbrew-telegram → Settings → Variables and Secrets</b> and add the secret <b>TELEGRAM_BOT_TOKEN</b>, then reload this page.</p>");
  }
  const test = url.searchParams.get("test");
  if (test) {
    const ok = await tellStaff(env, `👋 Test from <b>${esc(CLIENT.name)}</b> (${esc(CLIENT.domain)}). Website changes will be posted here.`, { chat: test });
    return htmlPage(ok ? "Test sent" : "Test failed", ok ? "<p>Check Telegram.</p>" : "<p>Telegram refused it. If it's a group, is the bot still in it? If it's a private chat, press Start in the bot first.</p>");
  }
  const updates = await telegram(env, "getUpdates", { allowed_updates: ["message", "my_chat_member"] }).catch(() => []);
  const chats = new Map();
  for (const u of updates) {
    const c = (u.message || u.my_chat_member)?.chat;
    if (c) chats.set(c.id, c.type === "private" ? `Private chat with ${[c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || "you"}` : c.title || String(c.id));
  }
  const target = CLIENT.telegramChat || hub?.chat || "";
  const now = target
    ? `<p>This site posts to chat ID <b>${esc(target)}</b>${env.TELEGRAM_HUB ? (CLIENT.telegramChat ? " (its own chat in client.json, through the WebBrew hub)" : " (the WebBrew hub's chat, shared by every site)") : ""}.</p>`
    : env.TELEGRAM_HUB
      ? "<p>This site is connected to the WebBrew hub, but the hub has no chat yet. Pick the chat below, then in Cloudflare open <b>Workers &amp; Pages → webbrew-telegram → Settings → Variables and Secrets</b> and add <b>TELEGRAM_CHAT</b> with its ID.</p>"
      : "<p>This site isn't posting to Telegram yet.</p>";
  const list = chats.size
    ? `<ul>${[...chats].map(([id, title]) => `<li><b>${esc(title)}</b>: ID <code>${id}</code> <a href="?test=${id}">send a test</a></li>`).join("")}</ul>`
    : "<p>No chats seen yet. Send the bot any message in Telegram (or add it to a group and send a message there), then reload this page.</p>";
  return htmlPage("Telegram", `${now}<p>Chats the bot has seen recently:</p>${list}<p class="muted">To get alerts just for yourself, open the bot in Telegram, press Start (or send it any message), reload this page and use the "Private chat" ID.</p>`);
}

// ---------- Email ----------

function emailHtml(heading, inner) {
  const t = CLIENT.theme;
  return `<!doctype html><html><body style="margin:0;background:${t.bg};font-family:Helvetica,Arial,sans-serif;color:#212121;line-height:1.5">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <img src="https://${CLIENT.domain}${t.logo}" alt="${esc(CLIENT.name)}" width="140" style="display:block;margin-bottom:16px">
  <div style="background:#fff;border:1px solid ${t.line};padding:20px">
    <p style="margin:0 0 14px;color:${t.muted};font-size:14px">${heading}</p>
    ${inner}
  </div>
  ${CLIENT.webbrewMark ? `<p style="font-size:12px;color:${t.muted};text-align:center;margin-top:16px">Website care by<br><img src="https://${CLIENT.domain}/c2c-assets/webbrew.png" alt="WebBrew" width="48" style="margin-top:6px"></p>` : ""}
</div></body></html>`;
}

function button(href, label, primary) {
  const t = CLIENT.theme;
  return `<a href="${esc(href)}" style="display:inline-block;padding:12px 22px;font-weight:bold;text-decoration:none;letter-spacing:1px;text-transform:uppercase;font-size:13px;border:1px solid ${t.accent};${primary ? `background:${t.accent};color:#fff` : `color:${t.accentInk}`}">${esc(label)}</a>`;
}

async function sendEmail(env, recipients, { subject, html, images = [] }) {
  const from = CLIENT.alertFrom;
  const boundary = `b${crypto.randomUUID()}`;
  const text = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<br\s*\/?>|<\/p>|<\/li>|<\/tr>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
  for (const to of recipients) {
    const parts = [
      `--${boundary}`,
      "Content-Type: multipart/alternative; boundary=alt" + boundary,
      "",
      `--alt${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap(utf8Base64(text)),
      `--alt${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap(utf8Base64(html)),
      `--alt${boundary}--`,
      ...images.flatMap((img) => [
        `--${boundary}`, "Content-Type: image/jpeg", "Content-Transfer-Encoding: base64", `Content-ID: <${img.cid}>`, `Content-Disposition: inline; filename="${img.cid}.jpg"`, "", wrap(img.base64),
      ]),
      `--${boundary}--`,
    ];
    const raw = [
      `From: ${CLIENT.name} website <${from}>`,
      `To: ${to}`,
      `Subject: =?utf-8?B?${utf8Base64(subject.replace(/[\r\n]+/g, " "))}?=`,
      `Message-ID: <${crypto.randomUUID()}@${CLIENT.domain}>`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/related; boundary=${boundary}`,
      "",
      ...parts,
    ].join("\r\n");
    // A failed alert (e.g. email not set up yet) is logged, never shown to the client: the request is already saved.
    try {
      await env.EMAIL.send(new EmailMessage(from, to, raw));
    } catch (err) {
      console.error(`email to ${to} failed`, err);
    }
  }
}

function utf8Base64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function wrap(b64) {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

// ---------- Admin HTML pages ----------

function htmlPage(title, inner, status = 200) {
  const t = CLIENT.theme;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} | ${esc(CLIENT.name)}</title><link rel="stylesheet" href="${esc(t.fontsUrl)}">
<style>body{margin:0;background:${t.bg};color:#212121;font-family:${t.body};line-height:1.6}main{max-width:560px;margin:0 auto;padding:40px 16px;display:grid;gap:12px}
h1{font-family:${t.display};font-weight:300;color:${t.accent};font-size:34px;margin:0}img.logo{width:140px}.muted{color:${t.muted};font-size:14px}a{color:${t.accentInk}}
button{font:inherit;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:12px 22px;cursor:pointer;border:1px solid ${t.accent};background:transparent;color:${t.accentInk}}button.primary{background:${t.accent};color:#fff}
h2{font-family:${t.display};font-weight:400;font-size:22px;margin:16px 0 0}ul{margin:0;padding-left:20px}p{margin:0}
.item{background:#fff;border:1px solid ${t.line};padding:16px;display:grid;gap:10px}.buttons{display:flex;flex-wrap:wrap;gap:8px}.done{background:${t.accentSoft};padding:10px 14px}
.webbrew{display:flex;justify-content:center;align-items:center;gap:8px;font-size:12px;color:${t.muted};margin-top:24px}.webbrew img{height:22px;width:auto}</style></head>
<body><main><img class="logo" src="${esc(t.logo)}" alt="${esc(CLIENT.name)}"><h1>${esc(title)}</h1>${inner}<p class="muted"><a href="/chat-to-change">Back to website changes</a></p>
${CLIENT.webbrewMark ? WEBBREW_MARK : ""}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

// ---------- Access login ----------

// Checks the Cloudflare Access login token, so the email header can't be faked by calling the Worker directly.
// Returns { email, exp } or null, and logs why a token was refused (see the Worker's logs in Cloudflare).
async function accessLogin(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  const no = (why) => (console.log(`login refused: ${why}`), null);
  if (!env.ACCESS_TEAM_DOMAIN) return no("ACCESS_TEAM_DOMAIN is not set");
  if (!token) return no("no Access token (is this address covered by the Access application?)");
  const [head, payload, sig] = token.split(".");
  if (!sig) return no("malformed token");
  let header, claims;
  try { header = JSON.parse(b64text(head)); claims = JSON.parse(b64text(payload)); } catch { return no("malformed token"); }
  const { keys } = await (await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)).json();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return no("signed with a key Access no longer lists");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64bytes(sig), new TextEncoder().encode(`${head}.${payload}`));
  if (!ok) return no("bad signature");
  if (claims.exp * 1000 < Date.now()) return no("expired");
  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return no(`issuer ${claims.iss}`);
  // ACCESS_AUD can list more than one tag (comma-separated), e.g. while a site moves to the shared WebBrew login.
  const auds = String(env.ACCESS_AUD || "").split(/[\s,]+/).filter(Boolean);
  if (auds.length && ![].concat(claims.aud).some((a) => auds.includes(a))) return no("wrong AUD tag");
  if (!claims.email) return no("no email in token");
  return { email: claims.email, exp: claims.exp };
}

function b64bytes(s) {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
}

function b64text(s) {
  return new TextDecoder().decode(b64bytes(s));
}

// Signs approval and undo links, keyed by the GitHub token so there's no extra secret to set up. Without a token of
// its own, the site asks the hub, and the site's repository is part of what's signed so a link only works on its site.
async function sign(env, text) {
  if (!env.GITHUB_TOKEN && env.TELEGRAM_HUB) {
    const res = await env.TELEGRAM_HUB.fetch("https://hub/sign", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `${CLIENT.repo}|${text}` }),
    });
    if (!res.ok) throw new Error(`hub sign: ${res.status} ${await res.text()}`);
    return (await res.json()).sig;
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GITHUB_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- GitHub ----------

// GitHub calls use the site's own GITHUB_TOKEN secret if it has one (older setups), otherwise the WebBrew hub's key.
function githubFetch(env, path, init = {}, accept = "application/vnd.github+json") {
  const headers = {
    Accept: accept,
    "User-Agent": "webbrew-chat-to-change",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
  };
  if (env.GITHUB_TOKEN) return fetch(`https://api.github.com${path}`, { ...init, headers: { ...headers, Authorization: `Bearer ${env.GITHUB_TOKEN}` } });
  if (env.TELEGRAM_HUB) return env.TELEGRAM_HUB.fetch(`https://hub/github${path}`, { ...init, headers });
  return Promise.reject(new Error("No GitHub key: set GITHUB_TOKEN on the WebBrew hub"));
}

async function github(env, path, init = {}) {
  const res = await githubFetch(env, path, init);
  if (!res.ok) throw new Error(`GitHub ${init.method || "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function readFile(env, path) {
  const res = await githubFetch(env, `/repos/${CLIENT.repo}/contents/${path}?ref=main`, {}, "application/vnd.github.raw+json");
  if (!res.ok) throw new Error(`GitHub read ${path}: ${res.status}`);
  return res.text();
}

// ---------- Helpers ----------

function parseJson(text) {
  if (typeof text !== "string") return text && typeof text === "object" ? text : null;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch {} }
  return null;
}

function base64Only(value) {
  if (typeof value !== "string") return "";
  const b64 = value.replace(/^data:[^,]*,/, "");
  return /^[A-Za-z0-9+/=]+$/.test(b64) ? b64 : "";
}

function stripFooter(body) {
  return String(body || "").replace(/\n+---\n_Generated by \[Claude Code\]\([^)]*\)_\s*$/, "").trim();
}

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

// ============================================================================
//  KOVIK INTELLIGENCE  -  AI Website Builder
//  Powered by Kovik Digital Solutions  |  Hajipur, Bihar
//
//  ONE FILE. Paste into a Cloudflare Worker. No build step, no npm.
//
//  ---------------------------------------------------------------------------
//  BINDINGS / SECRETS you must add in the dashboard
//  ---------------------------------------------------------------------------
//  KV namespace  (variable name: SITES)   -> stores sites, sessions, OTPs, quotas
//  Secret  GEMINI_KEY   -> from aistudio.google.com  (required)
//  Secret  BREVO_KEY    -> from brevo.com  (required, sends the OTP mail)
//
//  Optional variables (plain text is fine):
//    GMAIL_USER          your gmail address  (sends OTP through Gmail itself)
//    GMAIL_APP_PASSWORD  16-char Google App Password (NOT your normal password)
//    MAIL_FROM        default: rrsinha378@gmail.com   (used by the Brevo path)
//    MAIL_FROM_NAME   default: Kovik Intelligence
//    ALLOWED_EMAILS   comma separated. If set, ONLY these emails can log in.
//    LLM_BASE_URL     OpenAI-compatible endpoint (for Kovik LLM v later)
//    LLM_MODEL        model name for that endpoint
//    LLM_KEY          key for that endpoint
//
//  Routes
//    GET  /                     app (login or builder)
//    POST /api/otp              { email }
//    POST /api/verify           { email, code }
//    POST /api/logout
//    GET  /api/me
//    POST /api/art              { prompt }            -> design brief (JSON)
//    POST /api/build            { prompt, brief, previous?, instruction? } -> html
//    POST /api/publish          { html, brief, name }  -> { url }
//    POST /api/delete           { slug }
//    GET  /s/<slug>             the published site
// ============================================================================

const BRAND = {
  product: "Kovik Intelligence",
  tagline: "AI Website Builder",
  company: "Kovik Digital Solutions",
  hq: "Hajipur, Bihar",
  engine: "Kovik LLM v",
};

const MODEL = "gemini-3.8-flash"; // stable as of Nov 2026

const LIMITS = {
  dailyOps: 3,       // ONE shared budget per day: 1 new site = 1 op, 1 edit = 1 op
  gensPerDay: 20,    // hard safety net on AI calls
  otpPerEmail: 5,    // OTP requests per email per day
  mailsPerDay: 100,  // global cap on outbound OTP mails
};

const COOKIE = "kv_session";

// Daily caps. Override any of these with plain-text variables in the dashboard:
// SITES_PER_DAY, GENS_PER_DAY, OTP_PER_EMAIL, MAILS_PER_DAY
function L(env) {
  const num = (v, d) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : d;
  };
  return {
    dailyOps: num(env.DAILY_LIMIT, LIMITS.dailyOps),
    gensPerDay: num(env.GENS_PER_DAY, LIMITS.gensPerDay),
    otpPerEmail: num(env.OTP_PER_EMAIL, LIMITS.otpPerEmail),
    mailsPerDay: num(env.MAILS_PER_DAY, LIMITS.mailsPerDay)
  };
}

// The badge every generated site carries. Change WATERMARK_URL in the dashboard
// to point somewhere else; WATERMARK_TEXT changes the wording.
function watermarkUrl(env) {
  return env.WATERMARK_URL || "https://kovik.netlify.app";
}

function ensureWatermark(html, env) {
  const src = String(html || "");
  if (src.indexOf("data-kovik-badge") !== -1) return src;

  const url = watermarkUrl(env).replace(/"/g, "&quot;");
  const text = String(env.WATERMARK_TEXT || "Powered by Kovik Digital Solutions");
  const credit = "Built with " + ENGINE_LABEL + " &middot; " + text.replace(/</g, "&lt;");
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  const block =
    '<a data-kovik-badge href="' + url + '" target="_blank" rel="noopener" ' +
    'style="position:fixed;right:14px;bottom:14px;z-index:2147483000;display:inline-flex;' +
    "align-items:center;gap:7px;padding:9px 14px;border-radius:999px;text-decoration:none;" +
    "font:600 11.5px/1.2 " + font + ";letter-spacing:.2px;color:#ffffff;" +
    "background:rgba(10,12,17,.82);border:1px solid rgba(255,255,255,.16);" +
    'box-shadow:0 6px 20px rgba(0,0,0,.28);backdrop-filter:blur(6px)">' +
    '<span style="width:6px;height:6px;border-radius:50%;background:#6d8cff;display:inline-block"></span>' +
    text.replace(/</g, "&lt;") +
    "</a>" +
    '<div data-kovik-credit style="text-align:center;padding:20px 14px 26px;font:12px/1.5 ' + font + ';color:#8b95a8">' +
    '<a href="' + url + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">' +
    credit + "</a></div>";

  const lower = src.toLowerCase();
  const i = lower.lastIndexOf("</body>");
  if (i === -1) return src + block;
  return src.slice(0, i) + block + src.slice(i);
}

// ============================================================================
//  ROUTER
// ============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "GET" && path === "/") {
        return page(env);
      }
      if (request.method === "POST" && path === "/api/otp") return sendOtp(request, env);
      if (request.method === "POST" && path === "/api/verify") return verifyOtp(request, env);
      if (request.method === "POST" && path === "/api/logout") return logout();
      if (request.method === "GET" && path === "/api/me") return me(request, env);
      if (request.method === "POST" && path === "/api/art") return artStage(request, env);
      if (request.method === "POST" && path === "/api/build") return buildStage(request, env);
      if (request.method === "POST" && path === "/api/publish") return publish(request, env, url.origin);
      if (request.method === "POST" && path === "/api/update") return updateSite(request, env, url.origin);
      if (request.method === "POST" && path === "/api/restore") return restoreVersion(request, env);
      const siteHit = path.match(/^\/api\/site\/([a-z0-9-]{2,40})$/i);
      if (request.method === "GET" && siteHit) return getSite(request, env, siteHit[1].toLowerCase());
      if (request.method === "POST" && path === "/api/delete") return removeSite(request, env);

      const hit = path.match(/^\/s\/([a-z0-9-]{2,40})(\/.*)?$/i);
      if (request.method === "GET" && hit) {
        const slug = hit[1].toLowerCase();
        const rest = hit[2];
        if (rest === undefined) {
          return new Response(null, { status: 301, headers: { location: "/s/" + slug + "/" } });
        }
        return serveSite(env, slug, rest.replace(/^\/+/, ""));
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: scrub(String((err && err.message) || err)) }, 500);
    }
  }
};

// ============================================================================
//  SMALL UTILITIES
// ============================================================================

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8", "cache-control": "no-store" }
  });
}

function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html;charset=UTF-8", ...extra }
  });
}

function today() {
  // business day in IST
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function normEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validEmail(value) {
  return /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,20}$/.test(value);
}

function digits(len) {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => String(n % 10)).join("");
}

function token() {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function sessionCookie(value, maxAge) {
  return COOKIE + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
}

async function currentUser(request, env) {
  const t = readCookie(request, COOKIE);
  if (!t) return null;
  const raw = await env.SITES.get("sess:" + t);
  if (!raw) return null;
  try {
    return { token: t, ...JSON.parse(raw) };
  } catch {
    return null;
  }
}

async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) return { error: json({ error: "login required" }, 401) };
  return { user };
}

// Count a daily usage slot. Returns { ok, used, cap }.
async function bump(env, key, cap) {
  const used = Number((await env.SITES.get(key)) || 0);
  if (used >= cap) return { ok: false, used, cap };
  await env.SITES.put(key, String(used + 1), { expirationTtl: 172800 });
  return { ok: true, used: used + 1, cap };
}

async function usage(env, email) {
  const d = today();
  const [ops, gens] = await Promise.all([
    env.SITES.get("ops:" + email + ":" + d),
    env.SITES.get("gen:" + email + ":" + d),
  ]);
  return {
    day: d,
    ops: { used: Number(ops || 0), cap: L(env).dailyOps },
    gens: { used: Number(gens || 0), cap: L(env).gensPerDay },
  };
}

function opsKey(email) {
  return "ops:" + email + ":" + today();
}

async function opsLeftFor(env, email) {
  const used = Number((await env.SITES.get(opsKey(email))) || 0);
  return Math.max(0, L(env).dailyOps - used);
}

// ============================================================================
//  EMAIL (Brevo transactional API)
// ============================================================================

async function sendMail(env, to, subject, htmlBody) {
  const day = today();
  const slot = await bump(env, "mail:" + day, L(env).mailsPerDay);
  if (!slot.ok) throw new Error("Aaj ki email limit khatam ho gayi. Kal try karein.");

  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
    const openSocket = env.__openSocket || workerSocket;
    await smtpSend(
      openSocket,
      {
        host: "smtp.gmail.com",
        port: 587,
        user: String(env.GMAIL_USER).trim(),
        pass: String(env.GMAIL_APP_PASSWORD).replace(/\s+/g, "")
      },
      {
        to,
        subject,
        html: htmlBody,
        fromName: env.MAIL_FROM_NAME || BRAND.product
      }
    );
    return;
  }

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_KEY,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      sender: {
        email: env.MAIL_FROM || "rrsinha378@gmail.com",
        name: env.MAIL_FROM_NAME || BRAND.product
      },
      to: [{ email: to }],
      subject,
      htmlContent: htmlBody
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Email nahi gaya: " + text.slice(0, 200));
  }
}

// ---------------------------------------------------------------------------
//  Gmail SMTP  (used when GMAIL_USER + GMAIL_APP_PASSWORD are set)
//  Talks SMTP over a raw TCP socket from the Worker, no third party involved.
// ---------------------------------------------------------------------------

function b64(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function wrap76(s) {
  let out = "";
  for (let i = 0; i < s.length; i += 76) out += s.slice(i, i + 76) + "\r\n";
  return out;
}

function wrapRawSocket(raw) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let reader = raw.readable.getReader();
  let writer = raw.writable.getWriter();

  return {
    async write(text) {
      await writer.write(enc.encode(text));
    },
    async read() {
      const { value, done } = await reader.read();
      if (done) return null;
      return dec.decode(value, { stream: true });
    },
    async startTls() {
      try { reader.releaseLock(); } catch (e) {}
      try { writer.releaseLock(); } catch (e) {}
      const secure = raw.startTls();
      await secure.opened;
      return wrapRawSocket(secure);
    },
    close() {
      try { raw.close(); } catch (e) {}
    }
  };
}

async function workerSocket(host, port) {
  const mod = await import("cloudflare:sockets");
  return wrapRawSocket(mod.connect({ hostname: host, port }));
}

function buildMime(from, fromName, to, subject, htmlBody) {
  const domain = String(from).split("@")[1] || "localhost";
  const head = [
    'From: "' + String(fromName).replace(/"/g, "") + '" <' + from + ">",
    "To: <" + to + ">",
    "Subject: " + subject,
    "Date: " + new Date().toUTCString(),
    "Message-ID: <" + token() + "@" + domain + ">",
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated"
  ].join("\r\n");
  return head + "\r\n\r\n" + wrap76(b64(htmlBody));
}

// The protocol state machine. openSocket is injectable so this can be tested.
async function smtpSend(openSocket, cfg, mail) {
  let sock = await openSocket(cfg.host, cfg.port);
  let buf = "";

  const readChunk = async () => {
    const chunk = await sock.read();
    if (chunk === null) throw new Error("SMTP connection band ho gaya.");
    buf += chunk;
  };

  const readLine = async () => {
    while (buf.indexOf("\n") === -1) await readChunk();
    const i = buf.indexOf("\n");
    const line = buf.slice(0, i).replace(/\r$/, "");
    buf = buf.slice(i + 1);
    return line;
  };

  const expect = async (codes) => {
    const lines = [];
    for (;;) {
      const line = await readLine();
      lines.push(line);
      if (/^[0-9]{3} /.test(line)) break;
      if (!/^[0-9]{3}-/.test(line)) throw new Error("SMTP ne ajeeb jawab diya: " + line);
    }
    const code = Number(lines[lines.length - 1].slice(0, 3));
    if (codes.indexOf(code) === -1) {
      throw new Error("SMTP " + code + ": " + lines.join(" | ").slice(0, 200));
    }
    return lines;
  };

  try {
    await expect([220]);                                   // server greeting
    await sock.write("EHLO kovik\r\n");
    await expect([250]);

    await sock.write("STARTTLS\r\n");
    await expect([220]);
    sock = await sock.startTls();
    buf = "";

    await sock.write("EHLO kovik\r\n");
    await expect([250]);

    await sock.write("AUTH LOGIN\r\n");
    await expect([334]);
    await sock.write(b64(cfg.user) + "\r\n");
    await expect([334]);
    await sock.write(b64(cfg.pass) + "\r\n");
    await expect([235]);

    await sock.write("MAIL FROM:<" + cfg.user + ">\r\n");
    await expect([250]);
    await sock.write("RCPT TO:<" + mail.to + ">\r\n");
    await expect([250, 251]);
    await sock.write("DATA\r\n");
    await expect([354]);

    const mime = buildMime(cfg.user, mail.fromName, mail.to, mail.subject, mail.html);
    await sock.write(mime + "\r\n.\r\n");
    await expect([250]);

    try { await sock.write("QUIT\r\n"); } catch (e) {}
    return true;
  } finally {
    try { sock.close(); } catch (e) {}
  }
}

function otpMail(code) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:28px;background:#0b0d12;color:#e8ecf4;border-radius:16px">
    <div style="font-size:12px;letter-spacing:2px;color:#6d8cff;text-transform:uppercase">${BRAND.product}</div>
    <h2 style="margin:8px 0 4px;font-size:22px">Aapka login code</h2>
    <p style="color:#8b95a8;font-size:14px;margin:0 0 20px">Ye code 10 minute tak valid hai. Kisi ke saath share na karein.</p>
    <div style="font-size:34px;font-weight:700;letter-spacing:10px;background:#151922;border:1px solid #242a37;border-radius:12px;padding:18px;text-align:center">${code}</div>
    <p style="color:#8b95a8;font-size:12px;margin:22px 0 0">Agar aapne login nahi maanga, is mail ko ignore kar dein.</p>
    <hr style="border:0;border-top:1px solid #242a37;margin:20px 0">
    <p style="color:#6b7488;font-size:11px;margin:0">${BRAND.product} ${BRAND.tagline}<br>Powered by ${BRAND.company} &middot; ${BRAND.hq}</p>
  </div>`;
}

// ============================================================================
//  AUTH
// ============================================================================

async function sendOtp(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = normEmail(body.email);

  if (!validEmail(email)) return json({ error: "Sahi email address daalein." }, 400);

  const allow = String(env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => normEmail(e))
    .filter(Boolean);
  if (allow.length && !allow.includes(email)) {
    return json({ error: "Ye email is builder ke liye allowed nahi hai." }, 403);
  }

  const perEmail = await bump(env, "otpreq:" + email + ":" + today(), L(env).otpPerEmail);
  if (!perEmail.ok) return json({ error: "Aaj is email par " + L(env).otpPerEmail + " se zyada code nahi bhej sakte." }, 429);

  const code = digits(6);
  await env.SITES.put("otp:" + email, JSON.stringify({ code, tries: 0 }), { expirationTtl: 600 });

  try {
    await sendMail(env, email, code + " - aapka " + BRAND.product + " login code", otpMail(code));
  } catch (err) {
    return json({ error: String(err.message || err) }, 502);
  }

  return json({ ok: true, sentTo: email });
}

async function verifyOtp(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = normEmail(body.email);
  const code = String(body.code || "").replace(/\D/g, "");

  if (!validEmail(email) || code.length !== 6) return json({ error: "Email ya code adhura hai." }, 400);

  const key = "otp:" + email;
  const raw = await env.SITES.get(key);
  if (!raw) return json({ error: "Code expire ho gaya. Naya code maangein." }, 400);

  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return json({ error: "Code expire ho gaya. Naya code maangein." }, 400);
  }

  if (rec.tries >= 5) {
    await env.SITES.delete(key);
    return json({ error: "Bahut zyada galat koshish. Naya code maangein." }, 429);
  }

  if (rec.code !== code) {
    rec.tries += 1;
    await env.SITES.put(key, JSON.stringify(rec), { expirationTtl: 600 });
    return json({ error: "Code galat hai." }, 400);
  }

  await env.SITES.delete(key);

  const session = token();
  await env.SITES.put(
    "sess:" + session,
    JSON.stringify({ email, since: new Date().toISOString() }),
    { expirationTtl: 604800 }
  );

  return new Response(JSON.stringify({ ok: true, email }), {
    status: 200,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "cache-control": "no-store",
      "set-cookie": sessionCookie(session, 604800)
    }
  });
}

async function logout() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "set-cookie": sessionCookie("", 0)
    }
  });
}

async function me(request, env) {
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;

  const u = await usage(env, gate.user.email);
  const listRaw = await env.SITES.get("mysites:" + gate.user.email);
  let sites = [];
  try {
    sites = JSON.parse(listRaw || "[]");
  } catch {
    sites = [];
  }

  return json({
    email: gate.user.email,
    usage: u,
    sites,
    brand: BRAND,
    engine: engineLabel(env)
  });
}

const ENGINE_LABEL = "Kovik Intelligence AI Coder";

function engineLabel(env) {
  return ENGINE_LABEL;
}

// Nothing that names the underlying provider ever reaches a user.
function scrub(text) {
  return String(text == null ? "" : text)
    .replace(/gemini[\w.\-]*/gi, ENGINE_LABEL)
    .replace(/generativelanguage\.googleapis\.com/gi, "the model service")
    .replace(/Google AI Studio/gi, "the model service")
    .replace(/google/gi, "the platform");
}

// ============================================================================
//  AI  -  stage 1: art direction
// ============================================================================

const ART_RULES = `You are the art director at a design studio. You do NOT write code in this step.
Given a business idea, decide the creative direction for a single-page website.

Return ONLY valid JSON, no markdown, matching exactly this shape:
{
  "concept": "one sentence: the big idea behind this site",
  "audience": "who this is for",
  "tone": "three adjectives",
  "palette": { "bg": "#hex", "surface": "#hex", "ink": "#hex", "muted": "#hex", "accent": "#hex" },
  "typography": { "display": "a Google Font name", "body": "a Google Font name", "scale": "how type scales up on desktop" },
  "layout": "the grid and rhythm, one sentence",
  "sections": [ { "name": "Hero", "purpose": "what job it does", "content": "the actual words/items to put there" } ],
  "heroLine": "the real headline, not a placeholder",
  "subLine": "the real subheadline",
  "cta": "the primary button label",
  "avoid": "one cliche this design must not fall into",
  "pages": [ { "path": "index.html", "title": "Home", "purpose": "what this page is for" } ]
}

Rules: decide 2 to 4 pages. The first page MUST have path "index.html". Other paths look like
"services.html", "about.html", "contact.html" - lowercase, no slashes. Split the content sensibly
across those pages instead of cramming everything on the home page.
5 to 7 sections in total across the site. Every content field must contain REAL, specific copy written for this business -
never lorem ipsum, never "[your text here]". Colours must be a deliberate, harmonious set,
not random saturated defaults. Pick fonts that suit the tone. Be opinionated.`;

async function artStage(request, env) {
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => ({}));
  const prompt = String(body.prompt || "").trim();
  if (prompt.length < 10) return json({ error: "Apna idea thoda detail mein likhein." }, 400);

  const slot = await bump(env, "gen:" + gate.user.email + ":" + today(), L(env).gensPerDay);
  if (!slot.ok) return json({ error: "Aaj ki AI limit (" + L(env).gensPerDay + " calls) khatam. Kal try karein." }, 429);

  const raw = await callModel(env, ART_RULES + "\n\nBusiness idea:\n" + prompt, true);

  let brief;
  try {
    brief = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return json({ error: "Model ne theek jawab nahi diya. Dobara try karein." }, 502);
    try {
      brief = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return json({ error: "Design brief parse nahi hua. Dobara try karein." }, 502);
    }
  }

  const u = await usage(env, gate.user.email);
  return json({ brief, usage: u });
}

// ============================================================================
//  AI  -  stage 2: build the code
// ============================================================================

const BUILD_RULES = `You are a senior front-end engineer implementing an approved art direction.
Build a small MULTI-PAGE website. Output format is STRICT - for every page, one marker line,
then that page's complete HTML:

===PAGE:index.html|Home===
<!DOCTYPE html>...
===PAGE:about.html|About===
<!DOCTYPE html>...

Hard requirements:
- Output exactly the pages in the approved brief, 2 to 4 pages. The first MUST be index.html.
- Nothing outside the pages: no markdown fences, no commentary, no preamble.
- Every page is a complete, self-contained HTML file: CSS in one <style>, JS in one <script>.
- Navigation: identical header on every page, linking to the other pages with RELATIVE paths
  (href="about.html"), never absolute and never "/about". Highlight the current page.
- Mobile-first and genuinely responsive at 360px, 768px and 1280px.
- Google Fonts via <link> is allowed. Tailwind via CDN is allowed. No build tools, no local imports.
- No external images that can 404. Use CSS gradients, inline SVG, or https://images.unsplash.com/... URLs.
- Use the exact palette, fonts and copy from the approved brief. Do not invent different colours.
- Real content everywhere. No lorem ipsum, no placeholders.
- Accessible: semantic tags, alt text, visible focus states, contrast at least 4.5:1 for body text.
- Every page ends with a footer holding the business name and contact details.
- Do NOT add any "powered by" credit - it is appended automatically after your output.

Craft: generous whitespace, a clear type hierarchy, one accent colour used sparingly, and sections
that alternate rhythm so pages do not look like a stack of identical boxes.`;

const REFINE_RULES = `You are a senior front-end engineer editing an existing multi-page website.
Return ONLY the pages you actually changed, in this exact format - one marker line, then that page's
complete HTML:

===PAGE:index.html|Home===
<!DOCTYPE html>...

If a page needs no change, omit it entirely. No markdown fences, no commentary, nothing else.
Every page you return must be complete and self-contained, keep the same header and navigation,
use relative links (href="about.html"), and keep the approved palette and fonts.
Do NOT add any "powered by" credit.`;

const MAX_PAGES = 4;
const PAGE_MARK = "===PAGE:";
const PAGE_RE = /===PAGE:([^|\r\n]+)\|([^\r\n]*)===/g;

function safePath(input) {
  let s = String(input || "").toLowerCase().trim();
  s = s.replace(/^https?:\/\/[^/]+/i, "");
  s = s.split("?")[0].split("#")[0];
  s = s.replace(/[\s_]+/g, "-").replace(/-+/g, "-");
  s = s.replace(/[^a-z0-9._/-]/g, "");
  s = s.replace(/\.\./g, "").replace(/^\/+/, "");
  if (!s || s.endsWith("/")) s = s + "index.html";
  if (!/\.html?$/.test(s)) s = s + ".html";
  return s;
}

// Makes sure a generated multi-page site cannot ship with broken navigation:
// a missing index.html, or links pointing at pages that do not exist.
function repairPages(pages, full) {
  const list = pages.slice();
  if (!list.length) return list;

  // Only a complete page set can be repaired. A partial set (the pages the
  // model returned for one edit) must be merged first, then repaired.
  if (!full) return list;

  if (!list.some((p) => p.path === "index.html")) {
    list[0].path = "index.html";
    if (!list[0].title) list[0].title = "Home";
  }

  const known = {};
  list.forEach((p) => {
    known[p.path] = p.path;
    known[p.path.replace(/\.html?$/, "")] = p.path;
  });

  const fix = (href) => {
    if (!href) return null;
    if (/^(https?:|mailto:|tel:|#|javascript:|data:)/i.test(href)) return null;
    let clean = href.split("#")[0].split("?")[0].trim();
    clean = clean.replace(/^\.\//, "").replace(/^\/+/, "");
    if (!clean) return "index.html";
    if (known[clean]) return known[clean];
    const withHtml = /\.[a-z0-9]+$/i.test(clean) ? clean : clean + ".html";
    if (known[withHtml]) return known[withHtml];
    if (/\.html?$/i.test(clean)) return "index.html";
    return null;
  };

  list.forEach((p) => {
    p.html = String(p.html || "").replace(/href=(["'])([^"'>\s]+)\1/gi, (m, q, href) => {
      const fixed = fix(href);
      return fixed ? "href=" + q + fixed + q : m;
    });
  });

  return list;
}

function normalizePages(list, env, opts) {
  const full = !opts || opts.full !== false;
  const out = [];
  const seen = {};
  (list || []).forEach((p) => {
    if (!p) return;
    const path = safePath(p.path);
    if (seen[path]) return;
    seen[path] = 1;
    out.push({
      path,
      title: String(p.title || path.replace(/\.html?$/, "")).slice(0, 60),
      html: ensureWatermark(cleanHtml(p.html), env)
    });
  });
  if (!out.length) {
    out.push({ path: "index.html", title: "Home", html: ensureWatermark(cleanHtml(""), env) });
  }
  const fixed = repairPages(out, full);
  fixed.sort((a, b) => (a.path === "index.html" ? -1 : b.path === "index.html" ? 1 : 0));
  return fixed.slice(0, MAX_PAGES);
}

function parsePages(raw) {
  const text = String(raw || "");
  const marks = [];
  PAGE_RE.lastIndex = 0;
  let m;
  while ((m = PAGE_RE.exec(text)) !== null) {
    marks.push({ path: m[1], title: m[2], start: m.index, end: PAGE_RE.lastIndex });
  }
  if (!marks.length) return [{ path: "index.html", title: "Home", html: text }];
  const pages = [];
  for (let i = 0; i < marks.length; i++) {
    const to = i + 1 < marks.length ? marks[i + 1].start : text.length;
    pages.push({ path: marks[i].path, title: marks[i].title, html: text.slice(marks[i].end, to) });
  }
  return pages;
}

function pagesOf(rec) {
  if (rec && Array.isArray(rec.pages) && rec.pages.length) return rec.pages;
  if (rec && rec.html) return [{ path: "index.html", title: "Home", html: rec.html }];
  return [];
}

function incomingPages(body) {
  if (Array.isArray(body.pages) && body.pages.length) return body.pages;
  if (body.html) return [{ path: "index.html", title: "Home", html: body.html }];
  return [];
}

async function editsLeftFor(env, email) {
  return opsLeftFor(env, email);
}

function notFoundPage() {
  return (
    '<!DOCTYPE html><meta charset="utf-8"><title>Not found</title>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font-family:system-ui;padding:60px 24px;text-align:center;background:#0b0d12;color:#e8ecf4">' +
    "<h1>404</h1><p style=\"color:#8b95a8\">Ye page exist nahi karta.</p>" +
    '<p><a href="/" style="color:#6d8cff">Kovik Intelligence</a></p></body>'
  );
}

async function buildStage(request, env) {
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => ({}));
  const prompt = String(body.prompt || "").trim();
  const brief = body.brief ? JSON.stringify(body.brief, null, 2) : "";
  const prevPages = Array.isArray(body.pages) ? body.pages : [];
  const instruction = String(body.instruction || "").trim();
  const slug = String(body.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");

  const refining = prevPages.length > 0 && instruction.length > 0;
  if (!refining && !brief) return json({ error: "Pehle design brief banayein." }, 400);

  let editsLeft = null;
  if (refining) {
    const cap = L(env).dailyOps;
    const slot = await bump(env, opsKey(gate.user.email), cap);
    if (!slot.ok) {
      return json(
        {
          error:
            "Aaj ke " + cap + " operations khatam. Ek nayi site = 1 operation, ek edit = 1. " +
            "Kal midnight IST ke baad reset hoga."
        },
        429
      );
    }
    editsLeft = Math.max(0, cap - slot.used);
  } else {
    editsLeft = await opsLeftFor(env, gate.user.email);
  }

  const gen = await bump(env, "gen:" + gate.user.email + ":" + today(), L(env).gensPerDay);
  if (!gen.ok) {
    return json({ error: "Aaj ki AI limit (" + L(env).gensPerDay + " calls) khatam. Kal try karein." }, 429);
  }

  let task;
  if (refining) {
    const current = prevPages
      .map((pg) => PAGE_MARK + safePath(pg.path) + "|" + String(pg.title || "") + "===\n" + String(pg.html || ""))
      .join("\n\n");
    task =
      REFINE_RULES +
      "\n\nApproved art direction:\n" + brief +
      "\n\nCurrent pages:\n" + current +
      "\n\nApply ONLY this change and return only the pages you changed:\n" + instruction;
  } else {
    task = BUILD_RULES + "\n\nBusiness idea:\n" + prompt + "\n\nApproved art direction:\n" + brief;
  }

  const raw = await callModel(env, task, false, refining ? 16384 : 32768);
  const parsed = normalizePages(parsePages(raw), env, { full: !refining });

  let pages = parsed;
  if (refining) {
    const map = {};
    prevPages.forEach((pg) => { map[safePath(pg.path)] = pg; });
    parsed.forEach((pg) => { map[pg.path] = pg; });
    pages = normalizePages(Object.keys(map).map((k) => map[k]), env);
  }

  const u = await usage(env, gate.user.email);
  return json({ pages, usage: u, editsLeft });
}

function cleanHtml(raw) {
  let out = String(raw || "").trim();
  out = out.replace(/^```(?:html)?/i, "").replace(/```$/, "").trim();
  if (!/<html[\s>]/i.test(out)) {
    out =
      '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      "</head>\n<body>\n" + out + "\n</body>\n</html>";
  }
  return out;
}

// One place where the model is called. Gemini by default; any OpenAI-compatible
// endpoint if LLM_BASE_URL is set (that is where Kovik LLM v will plug in).
async function callModel(env, prompt, wantJson, maxOut) {
  if (env.LLM_BASE_URL) {
    const res = await fetch(env.LLM_BASE_URL.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + (env.LLM_KEY || "")
      },
      body: JSON.stringify({
        model: env.LLM_MODEL || MODEL,
        max_tokens: maxOut || 16384,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(scrub(data.error.message || "model error"));
    const text = data.choices && data.choices[0] && data.choices[0].message.content;
    if (!text) throw new Error("model returned nothing");
    return text;
  }

  if (!env.GEMINI_KEY) throw new Error("AI service abhi available nahi hai. Thodi der baad try karein.");

  const gen = { maxOutputTokens: maxOut || 16384 };
  if (wantJson) gen.responseMimeType = "application/json";
  // NOTE: Gemini 3.x rejects temperature / top_p / top_k. Do not add them.

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: gen
      })
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(scrub(data.error.message || "model error"));

  const parts =
    (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || "").join("");
  if (!text.trim()) throw new Error("Model khali jawab de gaya. Dobara try karein.");
  return text;
}

// ============================================================================
//  PUBLISH
// ============================================================================

function slugify(input) {
  const base = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return (base || "site") + "-" + Math.random().toString(36).slice(2, 6);
}

async function publish(request, env, origin) {
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => ({}));
  const incoming = incomingPages(body);
  if (!incoming.length) return json({ error: "Publish karne ke liye kuch nahi hai." }, 400);

  const pages = normalizePages(incoming, env);

  const slot = await bump(env, opsKey(gate.user.email), L(env).dailyOps);
  if (!slot.ok) {
    return json(
      {
        error:
          "Aaj ke " + L(env).dailyOps + " operations khatam. Ek nayi site = 1 operation, ek edit = 1. " +
          "Kal midnight IST ke baad reset hoga."
      },
      429
    );
  }

  const slug = slugify(body.name || body.prompt);
  const record = {
    slug,
    email: gate.user.email,
    name: String(body.name || "Untitled").slice(0, 80),
    prompt: String(body.prompt || "").slice(0, 2000),
    pages,
    html: pages[0].html,
    brief: body.brief || null,
    versions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await env.SITES.put("site:" + slug, JSON.stringify(record));

  const indexKey = "mysites:" + gate.user.email;
  let list = [];
  try {
    list = JSON.parse((await env.SITES.get(indexKey)) || "[]");
  } catch {
    list = [];
  }
  list = [
    { slug, name: record.name, createdAt: record.createdAt },
    ...list.filter((x) => x.slug !== slug)
  ].slice(0, 50);
  await env.SITES.put(indexKey, JSON.stringify(list));

  const u = await usage(env, gate.user.email);
  return json({
    url: origin + "/s/" + slug + "/",
    slug,
    usage: u,
    editsLeft: Math.max(0, L(env).dailyOps - slot.used),
    pages: pages.map((x) => ({ path: x.path, title: x.title }))
  });
}

const MAX_VERSIONS = 5;

async function ownedSite(env, email, slug) {
  const raw = await env.SITES.get("site:" + slug);
  if (!raw) return null;
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (rec.email !== email) return null;
  return rec;
}

async function getSite(request, env, slug) {
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;

  const rec = await ownedSite(env, gate.user.email, slug);
  if (!rec) return json({ error: "Site nahi mili." }, 404);

  const pages = pagesOf(rec);
  return json({
    site: {
      slug: rec.slug,
      name: rec.name,
      prompt: rec.prompt || "",
      pages,
      brief: rec.brief || null,
      versions: rec.versions || [],
      editsLeft: await opsLeftFor(env, gate.user.email),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt || rec.createdAt
    }
  });
}

// Update an existing site. Does not consume the daily publish quota.
async function updateSite(request, env, origin) {
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => ({}));
  const slug = String(body.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!slug) return json({ error: "slug missing" }, 400);

  const incoming = incomingPages(body);
  if (!incoming.length) return json({ error: "Update karne ke liye kuch nahi hai." }, 400);

  const rec = await ownedSite(env, gate.user.email, slug);
  if (!rec) return json({ error: "Site nahi mili." }, 404);

  const oldPages = pagesOf(rec);
  const newPages = normalizePages(incoming, env);
  const changed = JSON.stringify(oldPages) !== JSON.stringify(newPages);

  const versions = Array.isArray(rec.versions) ? rec.versions.slice() : [];
  if (oldPages.length && changed) {
    const id = String(Date.now());
    await env.SITES.put("ver:" + slug + ":" + id, JSON.stringify({ pages: oldPages }), {
      expirationTtl: 2592000
    });
    versions.unshift({ id, at: new Date().toISOString() });
    for (const old of versions.slice(MAX_VERSIONS)) {
      try { await env.SITES.delete("ver:" + slug + ":" + old.id); } catch (e) {}
    }
    rec.versions = versions.slice(0, MAX_VERSIONS);
  }

  if (changed) {
    rec.pages = newPages;
    rec.html = newPages[0].html;
  }
  if (body.brief) rec.brief = body.brief;
  if (body.name) rec.name = String(body.name).slice(0, 80);
  rec.updatedAt = new Date().toISOString();

  await env.SITES.put("site:" + slug, JSON.stringify(rec));

  const indexKey = "mysites:" + gate.user.email;
  let list = [];
  try {
    list = JSON.parse((await env.SITES.get(indexKey)) || "[]");
  } catch {
    list = [];
  }
  list = list.map((x) => (x.slug === slug ? { ...x, name: rec.name, updatedAt: rec.updatedAt } : x));
  await env.SITES.put(indexKey, JSON.stringify(list));

  return json({
    url: origin + "/s/" + slug + "/",
    slug,
    versions: rec.versions || [],
    updatedAt: rec.updatedAt
  });
}

async function restoreVersion(request, env) {
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => ({}));
  const slug = String(body.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const id = String(body.id || "").replace(/[^0-9]/g, "");
  if (!slug || !id) return json({ error: "slug ya version missing" }, 400);

  const rec = await ownedSite(env, gate.user.email, slug);
  if (!rec) return json({ error: "Site nahi mili." }, 404);

  const raw = await env.SITES.get("ver:" + slug + ":" + id);
  if (!raw) return json({ error: "Ye version ab available nahi hai." }, 404);

  let pages;
  if (raw.trim().charAt(0) === "{") {
    try {
      pages = JSON.parse(raw).pages || [];
    } catch (e) {
      pages = [];
    }
  } else {
    pages = [{ path: "index.html", title: "Home", html: raw }];
  }
  if (!pages.length) return json({ error: "Ye version khali hai." }, 404);

  return json({ pages });
}

async function removeSite(request, env) {
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => ({}));
  const slug = String(body.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!slug) return json({ error: "slug missing" }, 400);

  const raw = await env.SITES.get("site:" + slug);
  if (!raw) return json({ error: "Site nahi mili." }, 404);

  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return json({ error: "Site nahi mili." }, 404);
  }
  if (rec.email !== gate.user.email) return json({ error: "Ye site aapki nahi hai." }, 403);

  await env.SITES.delete("site:" + slug);

  const indexKey = "mysites:" + gate.user.email;
  let list = [];
  try {
    list = JSON.parse((await env.SITES.get(indexKey)) || "[]");
  } catch {
    list = [];
  }
  await env.SITES.put(indexKey, JSON.stringify(list.filter((s) => s.slug !== slug)));

  return json({ ok: true });
}

async function serveSite(env, slug, sub) {
  const raw = await env.SITES.get("site:" + slug);
  if (!raw) return html(notFoundPage(), 404);

  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return html("Site data is broken.", 500);
  }

  const pages = pagesOf(rec);
  const want = sub ? safePath(sub) : "index.html";
  const page = pages.find((p) => p.path === want);

  if (!page) return html(notFoundPage(), 404);

  return html(page.html, 200, {
    "cache-control": "public, max-age=60",
    "x-content-type-options": "nosniff"
  });
}

// ============================================================================
//  THE PAGE
// ============================================================================

function page(env) {
  return html(SHELL);
}

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b0d12">
<title>Kovik Intelligence AI Coder — Website Builder</title>
<meta name="description" content="Kovik Intelligence AI Coder — build and publish a website from one line of text. Powered by Kovik Digital Solutions, Hajipur.">
<style>
  :root{
    --bg:#0a0c11; --panel:#12161f; --panel2:#171c27; --line:#232a38;
    --ink:#e9edf5; --dim:#8b95a8; --faint:#5d6678;
    --accent:#6d8cff; --accent-ink:#071031; --good:#37d39a; --bad:#ff6b6b;
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0}
  body{
    background:var(--bg); color:var(--ink);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    min-height:100dvh;
  }
  a{color:var(--accent)}
  .wrap{max-width:760px;margin:0 auto;padding:0 16px 40px}

  /* brand */
  .brandbar{display:flex;align-items:center;gap:10px;padding:16px 0;border-bottom:1px solid var(--line)}
  .mark{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--accent),#a06dff);
    display:grid;place-items:center;font-weight:800;font-size:15px;color:#0a0c11;flex:none}
  .brandtext b{display:block;font-size:14.5px;letter-spacing:.2px}
  .brandtext span{display:block;font-size:11px;color:var(--faint);letter-spacing:.4px;text-transform:uppercase}
  .who{margin-left:auto;text-align:right;font-size:11px;color:var(--faint);line-height:1.35;max-width:42%}
  .who b{color:var(--dim);font-weight:600;display:block;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}

  /* generic */
  h1{font-size:26px;line-height:1.2;margin:26px 0 8px;letter-spacing:-.4px}
  h2{font-size:17px;margin:0 0 10px;letter-spacing:-.2px}
  p.lede{color:var(--dim);margin:0 0 22px;font-size:14.5px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;margin:0 0 14px}
  label{display:block;font-size:12px;color:var(--dim);margin:0 0 6px;letter-spacing:.3px;text-transform:uppercase}
  input,textarea,select{
    width:100%;background:var(--panel2);color:var(--ink);border:1px solid var(--line);
    border-radius:12px;padding:13px;font:inherit;outline:none;
  }
  input:focus,textarea:focus{border-color:var(--accent)}
  textarea{min-height:96px;resize:vertical}
  .row{display:flex;gap:9px;flex-wrap:wrap}
  .row>*{flex:1 1 auto}
  .row>button{flex:1 1 0;min-width:132px}
  button{
    min-height:46px;padding:0 16px;border-radius:12px;border:1px solid var(--line);
    background:var(--panel2);color:var(--ink);font:inherit;font-weight:600;cursor:pointer;
    transition:transform .06s ease,opacity .15s ease;
  }
  button:active{transform:scale(.985)}
  button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
  button.ghost{background:transparent}
  button.danger{color:var(--bad);border-color:#3a2430}
  button:disabled{opacity:.45;cursor:default;transform:none}
  .hint{font-size:12px;color:var(--faint);margin:8px 0 0}
  .status{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dim);min-height:20px;margin:2px 0 12px}
  .spin{width:9px;height:9px;border-radius:50%;background:var(--accent);animation:pulse 1s infinite}
  @keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
  .err{color:var(--bad);font-size:13px;margin:8px 0 0}

  /* chips */
  .chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
  .chip{font-size:11.5px;color:var(--dim);background:var(--panel);border:1px solid var(--line);
    border-radius:999px;padding:6px 11px}
  .chip b{color:var(--ink)}

  /* brief */
  .swatches{display:flex;gap:8px;margin:12px 0}
  .sw{width:38px;height:38px;border-radius:10px;border:1px solid rgba(255,255,255,.14)}
  .kv{display:flex;gap:10px;font-size:13px;padding:7px 0;border-top:1px solid var(--line)}
  .kv span{color:var(--faint);min-width:74px;flex:none}
  .sections{list-style:none;margin:10px 0 0;padding:0;counter-reset:s}
  .sections li{counter-increment:s;position:relative;padding:9px 0 9px 30px;border-top:1px solid var(--line);font-size:13px}
  .sections li:before{content:counter(s);position:absolute;left:0;top:10px;width:19px;height:19px;
    border-radius:6px;background:var(--panel2);border:1px solid var(--line);display:grid;place-items:center;
    font-size:10.5px;color:var(--dim)}
  .sections b{display:block;font-size:13px}
  .sections em{color:var(--dim);font-style:normal;font-size:12.5px}

  /* preview */
  .tabs{display:flex;gap:7px;overflow-x:auto;padding:0 0 10px;-webkit-overflow-scrolling:touch}
  .tabs::-webkit-scrollbar{display:none}
  .tab{flex:none;min-height:34px;padding:0 13px;border-radius:9px;font-size:12.5px;font-weight:600;
    background:var(--panel2);border:1px solid var(--line);color:var(--dim);cursor:pointer}
  .tab.on{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
  .frame{width:100%;height:58vh;min-height:340px;border:1px solid var(--line);border-radius:14px;
    overflow:hidden;background:#fff}
  .frame iframe{width:100%;height:100%;border:0;display:block}
  .empty{display:grid;place-items:center;height:100%;color:#7b8598;font-size:13px;padding:24px;text-align:center}

  .linkbox{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px;
    font-size:13px;word-break:break-all;margin:0 0 14px}
  .linkbox a{font-weight:600}

  .sitelist{list-style:none;margin:0;padding:0}
  .sitelist li{display:flex;align-items:center;gap:10px;padding:11px 0;border-top:1px solid var(--line);font-size:13px}
  .sitelist li:first-child{border-top:0}
  .sitelist a{flex:1;text-decoration:none;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sitelist small{color:var(--faint);font-size:11px;display:block}
  .iconbtn{min-height:34px;padding:0 10px;font-size:12px;border-radius:9px;flex:none}
  .editbar{display:flex;align-items:center;gap:8px;background:#16202e;border:1px solid #2b3d55;
    border-radius:11px;padding:9px 11px;font-size:12px;color:#a8b6cc;margin:0 0 12px}
  .editbar b{color:var(--ink);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  .vers{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 10px}
  .vers .v{font-size:11.5px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);
    border-radius:8px;padding:6px 9px;cursor:pointer;min-height:0}
  .vers .v:hover{border-color:var(--accent);color:var(--ink)}

  footer{margin-top:26px;padding-top:16px;border-top:1px solid var(--line);color:var(--faint);font-size:11.5px;line-height:1.7}
  footer b{color:var(--dim);font-weight:600}
  .hide{display:none!important}
</style>
</head>
<body>
<div class="wrap">

  <div class="brandbar">
    <div class="mark">K</div>
    <div class="brandtext">
      <b>Kovik Intelligence</b>
      <span>AI Coder</span>
    </div>
    <div class="who hide" id="who">
      <b id="whoEmail"></b>
      <button class="iconbtn" style="margin-top:6px" onclick="doLogout()">Logout</button>
    </div>
  </div>

  <!-- ================= LOGIN ================= -->
  <section id="login">
    <h1>Apni website, ek idea se.</h1>
    <p class="lede">Business batao. Hum pehle design direction banayenge, aap approve karoge, phir site banegi aur live ho jayegi.</p>

    <div class="card">
      <label for="email">Email</label>
      <input id="email" type="email" inputmode="email" autocomplete="email" placeholder="aapka@email.com">
      <div class="row" style="margin-top:12px">
        <button class="primary" id="btnOtp" onclick="askOtp()">Login code bhejo</button>
      </div>
      <div id="otpStep" class="hide" style="margin-top:16px">
        <label for="code">6-digit code</label>
        <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">
        <div class="row" style="margin-top:12px">
          <button class="primary" id="btnVerify" onclick="verify()">Login karo</button>
          <button class="ghost" onclick="askOtp()">Dobara bhejo</button>
        </div>
        <p class="hint">Code 10 minute ke liye valid hai.</p>
      </div>
      <div class="err hide" id="loginErr"></div>
    </div>

    <p class="hint">Roz 3 operations milte hain. Ek nayi site = 1, ek edit = 1. Midnight IST par reset.</p>
  </section>

  <!-- ================= APP ================= -->
  <section id="app" class="hide">
    <div class="chips" id="chips"></div>

    <div class="card">
      <h2>1. Business batao</h2>
      <label for="prompt">Kya banana hai?</label>
      <textarea id="prompt" placeholder="e.g. Hajipur mein ek dental clinic. Services, timings, WhatsApp par appointment, Hindi + English dono mein. Serious aur bharosemand feel chahiye."></textarea>
      <div class="row" style="margin-top:12px">
        <button class="primary" id="btnArt" onclick="runArt()">Design direction banao</button>
      </div>
      <p class="hint">Ye step pehle sochta hai — colours, fonts, sections, actual copy — phir code likhta hai.</p>
      <div class="err hide" id="artErr"></div>
    </div>

    <div class="status" id="status1"><span id="spin1" class="spin hide"></span><span id="msg1"></span></div>

    <!-- brief -->
    <div class="card hide" id="briefCard">
      <h2>2. Design direction — approve karein</h2>
      <div id="briefBody"></div>
      <div class="row" style="margin-top:14px">
        <button class="primary" id="btnBuild" onclick="runBuild()">Aage badho — site banao</button>
        <button class="ghost" onclick="runArt()">Phir se socho</button>
      </div>
      <div class="err hide" id="buildErr"></div>
    </div>

    <div class="status" id="status2"><span id="spin2" class="spin hide"></span><span id="msg2"></span></div>

    <!-- preview -->
    <div class="card hide" id="previewCard">
      <h2>3. Preview</h2>
      <div class="editbar hide" id="editBar">
        Editing <b id="editName"></b>
        <button class="iconbtn" onclick="newSite()">Naya site</button>
      </div>
      <div class="tabs hide" id="pageTabs"></div>
      <div class="frame" id="frame"><div class="empty">Yahan dikhega</div></div>
      <label for="tweak" style="margin-top:14px">Change chahiye?</label>
      <textarea id="tweak" style="min-height:64px" placeholder="e.g. hero bada karo, pricing section add karo, accent thoda warm karo"></textarea>
      <div class="row" style="margin-top:12px">
        <button id="btnRefine" onclick="runRefine()">Change lagao</button>
        <button class="primary" id="btnPub" onclick="runPublish()">Publish karo</button>
        <button id="btnUndo" onclick="undoEdit()">Undo</button>
      </div>
      <div class="vers hide" id="versions"></div>
      <p class="hint" id="pubHint"></p>
      <div class="err hide" id="pubErr"></div>
      <div class="linkbox hide" id="linkBox"></div>
    </div>

    <div class="card" id="sitesCard">
      <h2>Meri sites</h2>
      <ul class="sitelist" id="siteList"><li style="color:var(--faint);font-size:13px">Abhi kuch nahi.</li></ul>
    </div>
  </section>

  <footer>
    <b>Kovik Intelligence AI Coder</b> — AI Website Builder<br>
    Powered by <b>Kovik Digital Solutions</b> · Hajipur, Bihar<br>
    Engine: <span id="engine">Kovik Intelligence AI Coder</span>
  </footer>
</div>

<script>
  var state = { user:null, brief:null, prompt:"", usage:null, sites:[], slug:null,
                pages:[], active:0, undo:[], editsLeft:null };

  var $ = function (id) { return document.getElementById(id); };
  function show(el, on) { if (el) el.classList.toggle("hide", !on); }

  function setStatus(n, text, busy) {
    show($("spin" + n), busy);
    $("msg" + n).textContent = text || "";
  }
  function setErr(id, text) {
    var el = $(id);
    if (!text) { show(el, false); el.textContent = ""; return; }
    el.textContent = text;
    show(el, true);
  }
  function lock(on) {
    ["btnArt","btnBuild","btnRefine","btnPub","btnUndo","btnOtp","btnVerify"].forEach(function (id) {
      var el = $(id); if (el) el.disabled = on;
    });
  }

  async function api(path, body) {
    var res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) { var err = new Error(data.error || ("HTTP " + res.status)); err.status = res.status; throw err; }
    return data;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c];
    });
  }
  function clonePages() { return JSON.parse(JSON.stringify(state.pages || [])); }

  // ---------------- auth ----------------
  async function askOtp() {
    setErr("loginErr", "");
    var email = $("email").value.trim().toLowerCase();
    if (!email) { setErr("loginErr", "Pehle email daalein."); return; }
    lock(true);
    try {
      await api("/api/otp", { email: email });
      show($("otpStep"), true);
      $("code").focus();
      $("btnOtp").textContent = "Code bhej diya";
    } catch (e) {
      setErr("loginErr", e.message);
    } finally { lock(false); }
  }

  async function verify() {
    setErr("loginErr", "");
    var email = $("email").value.trim().toLowerCase();
    var code = $("code").value.replace(/\\D/g, "");
    if (code.length !== 6) { setErr("loginErr", "6 digit ka code daalein."); return; }
    lock(true);
    try {
      await api("/api/verify", { email: email, code: code });
      await boot();
    } catch (e) {
      setErr("loginErr", e.message);
    } finally { lock(false); }
  }

  async function doLogout() {
    if (!confirm("Logout karna hai?")) return;
    await api("/api/logout", {});
    location.reload();
  }

  // ---------------- boot ----------------
  async function boot() {
    var data;
    try { data = await api("/api/me"); }
    catch (e) {
      show($("login"), true); show($("app"), false); show($("who"), false);
      return;
    }
    state.user = data.email;
    state.usage = data.usage;
    state.sites = data.sites || [];
    $("whoEmail").textContent = data.email;
    $("engine").textContent = data.engine;
    show($("who"), true); show($("login"), false); show($("app"), true);
    paintUsage();
    paintSites();
  }

  function paintUsage() {
    var u = state.usage; if (!u) return;
    $("chips").innerHTML =
      '<div class="chip">Aaj: <b>' + u.ops.used + "/" + u.ops.cap + " operations</b></div>" +
      '<div class="chip">Reset: <b>midnight IST</b></div>';
    var left = u.ops.cap - u.ops.used;
    $("pubHint").textContent = left > 0
      ? "Aaj " + left + " operation" + (left === 1 ? "" : "s") + " bache. Nayi site = 1, edit = 1."
      : "Aaj ke " + u.ops.cap + " operations khatam. Kal midnight IST ke baad reset hoga.";
    $("btnPub").disabled = left <= 0;
  }

  function paintEdits() {
    var el = $("editName");
    if (el) {
      el.textContent = state.slug
        ? "/s/" + state.slug + (state.editsLeft === null ? "" : " · " + state.editsLeft + " left")
        : "";
    }
  }

  function paintSites() {
    var ul = $("siteList");
    if (!state.sites.length) {
      ul.innerHTML = '<li style="color:var(--faint);font-size:13px">Abhi kuch nahi.</li>';
      return;
    }
    ul.innerHTML = state.sites.map(function (s) {
      var when = (s.createdAt || "").slice(0, 10);
      return '<li><a href="/s/' + s.slug + '/" target="_blank" rel="noopener">' +
        escapeHtml(s.name || s.slug) + "<small>/s/" + s.slug + " · " + when + "</small></a>" +
        '<button class="iconbtn" data-slug="' + s.slug + '" onclick="openSite(this.dataset.slug)">Edit</button>' +
        '<button class="iconbtn danger" data-slug="' + s.slug + '" onclick="delSite(this.dataset.slug)">Delete</button></li>';
    }).join("");
  }

  // ---------------- stage 1: art direction ----------------
  async function runArt() {
    setErr("artErr", ""); setErr("buildErr", "");
    var prompt = $("prompt").value.trim();
    if (prompt.length < 10) { setErr("artErr", "Idea thoda detail mein likhein (kam se kam 10 characters)."); return; }
    if (state.brief && !confirm("Naya design direction banao? Purana brief replace ho jayega, aur ek AI call lagegi.")) return;

    state.prompt = prompt;
    lock(true); setStatus(1, "Design direction soch raha hoon...", true);
    try {
      var data = await api("/api/art", { prompt: prompt });
      state.brief = data.brief;
      state.usage = data.usage;
      paintUsage();
      paintBrief(data.brief);
      show($("briefCard"), true);
      show($("previewCard"), false);
      setStatus(1, "Design direction ready hai. Neeche padho, phir approve karo.");
    } catch (e) {
      setErr("artErr", e.message);
      setStatus(1, "");
    } finally { lock(false); }
  }

  function kv(k, v) {
    return '<div class="kv"><span>' + escapeHtml(k) + "</span><div>" + escapeHtml(v) + "</div></div>";
  }

  function paintBrief(b) {
    var p = b.palette || {};
    var t = b.typography || {};
    var rows = "";
    if (b.concept) rows += kv("Concept", b.concept);
    if (b.audience) rows += kv("Audience", b.audience);
    if (b.tone) rows += kv("Tone", b.tone);
    if (b.layout) rows += kv("Layout", b.layout);
    if (t.display) rows += kv("Fonts", t.display + " + " + (t.body || ""));
    if (b.avoid) rows += kv("Avoid", b.avoid);

    var sw = "";
    ["bg","surface","ink","muted","accent"].forEach(function (k) {
      if (p[k]) sw += '<div class="sw" title="' + k + " " + p[k] + '" style="background:' + p[k] + '"></div>';
    });

    var pageRow = "";
    if (b.pages && b.pages.length) {
      pageRow = kv("Pages", b.pages.map(function (x) { return x.title || x.path; }).join(" · "));
    }

    var secs = (b.sections || []).map(function (s) {
      return "<li><b>" + escapeHtml(s.name || "") + "</b><em>" +
        escapeHtml(s.purpose || "") + (s.content ? " — " + escapeHtml(s.content) : "") + "</em></li>";
    }).join("");

    var hero = "";
    if (b.heroLine) hero += kv("Headline", b.heroLine);
    if (b.subLine) hero += kv("Subline", b.subLine);
    if (b.cta) hero += kv("Button", b.cta);

    $("briefBody").innerHTML =
      (b.concept ? '<p style="font-size:14px;color:var(--dim);margin:0 0 12px">' + escapeHtml(b.concept) + "</p>" : "") +
      '<div class="swatches">' + sw + "</div>" +
      hero + pageRow + rows +
      (secs ? '<ul class="sections">' + secs + "</ul>" : "");
  }

  // ---------------- stage 2: build ----------------
  async function runBuild() {
    if (!state.brief) { setErr("buildErr", "Pehle design direction banayein."); return; }
    if (!confirm("Poori multi-page site likhna shuru karein? Ek AI call lagegi.")) return;

    setErr("buildErr", "");
    lock(true); setStatus(2, "Pages likh raha hoon...", true);
    try {
      var data = await api("/api/build", { prompt: state.prompt, brief: state.brief });
      state.pages = data.pages || [];
      state.active = 0;
      state.undo = [];
      state.usage = data.usage;
      paintUsage();
      showPreview(state.pages);
      show($("previewCard"), true);
      show($("linkBox"), false);
      setStatus(2, state.pages.length + " page ban gaye. Tabs se dekh lo, change maango ya publish karo.");
    } catch (e) {
      setErr("buildErr", e.message);
      setStatus(2, "");
    } finally { lock(false); }
  }

  async function runRefine() {
    if (!state.pages.length) { setStatus(2, "Pehle site banao."); return; }
    var instruction = $("tweak").value.trim();
    if (!instruction) { setErr("pubErr", "Kya change karna hai, likhein."); return; }
    if (state.editsLeft !== null && state.editsLeft <= 0) {
      setErr("pubErr", "Aaj ke operations khatam ho gaye. Kal midnight IST ke baad reset honge.");
      return;
    }
    if (!confirm("Ye change lagau? Ek AI call lagegi aur 1 operation khayega.")) return;

    setErr("pubErr", "");
    lock(true); setStatus(2, "Change laga raha hoon...", true);
    try {
      var data = await api("/api/build", {
        prompt: state.prompt, brief: state.brief,
        pages: state.pages, instruction: instruction, slug: state.slug
      });
      state.undo.push(clonePages());
      state.pages = data.pages || state.pages;
      state.usage = data.usage;
      if (typeof data.editsLeft === "number") state.editsLeft = data.editsLeft;
      paintUsage(); paintEdits();
      showPreview(state.pages);
      $("tweak").value = "";
      setStatus(2, "Update ho gaya." + (state.editsLeft === null ? "" : " Aaj " + state.editsLeft + " edit bache."));
    } catch (e) {
      setErr("pubErr", e.message);
      setStatus(2, "");
    } finally { lock(false); }
  }

  // ---------------- preview ----------------
  function paintTabs() {
    var box = $("pageTabs");
    if (!state.pages.length) { show(box, false); box.innerHTML = ""; return; }
    box.innerHTML = state.pages.map(function (p, i) {
      return '<button class="tab' + (i === state.active ? " on" : "") + '" data-i="' + i +
        '" onclick="switchPage(this.dataset.i)">' + escapeHtml(p.title || p.path) + "</button>";
    }).join("");
    show(box, true);
  }

  function switchPage(i) {
    state.active = Number(i) || 0;
    paintTabs();
    renderFrame();
  }

  function renderFrame() {
    var frame = $("frame");
    var p = state.pages[state.active];
    if (!p) { frame.innerHTML = '<div class="empty">Yahan dikhega</div>'; return; }
    frame.innerHTML = "";
    var f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts allow-popups allow-forms allow-same-origin");
    f.srcdoc = p.html;
    frame.appendChild(f);
  }

  function showPreview(pages) {
    state.pages = pages || [];
    if (state.active >= state.pages.length) state.active = 0;
    paintTabs();
    renderFrame();
  }

  // ---------------- publish ----------------
  async function runPublish() {
    if (!state.pages.length) return;
    if (state.slug) { await updateCurrent(); return; }

    var left = state.usage ? state.usage.ops.cap - state.usage.ops.used : 0;
    if (left <= 0) { setErr("pubErr", "Aaj ka publish quota khatam."); return; }

    var name = prompt("Site ka naam kya rakhein? (link isi se banega)", "kovik-site");
    if (name === null) return;
    if (!confirm("Publish karein? " + state.pages.length + " pages live jayenge, aur 1 operation khayega (" + left + " bache hain).")) return;

    setErr("pubErr", "");
    lock(true); setStatus(2, "Publish kar raha hoon...", true);
    try {
      var data = await api("/api/publish", {
        pages: state.pages, brief: state.brief, name: name, prompt: state.prompt
      });
      state.usage = data.usage;
      state.slug = data.slug;
      state.editsLeft = data.editsLeft === undefined ? 3 : data.editsLeft;
      paintUsage(); paintEdits();
      show($("editBar"), true);
      $("btnPub").textContent = "Update site";
      var box = $("linkBox");
      box.innerHTML = 'Live ho gaya: <a href="' + data.url + '" target="_blank" rel="noopener">' + data.url + "</a>";
      show(box, true);
      setStatus(2, "Publish ho gaya.");
      var me2 = await api("/api/me");
      state.sites = me2.sites || [];
      paintSites();
    } catch (e) {
      setErr("pubErr", e.message);
      setStatus(2, "");
    } finally { lock(false); }
  }

  async function updateCurrent() {
    if (!confirm("Is site ko update karein? Purana version save rahega, baad mein wapas la sakte ho.")) return;
    setErr("pubErr", "");
    lock(true); setStatus(2, "Update kar raha hoon...", true);
    try {
      var d = await api("/api/update", { slug: state.slug, pages: state.pages, brief: state.brief });
      paintVersions(d.versions || []);
      var box = $("linkBox");
      box.innerHTML = 'Live: <a href="' + d.url + '" target="_blank" rel="noopener">' + d.url + "</a>";
      show(box, true);
      setStatus(2, "Update ho gaya. Ye update aaj ka site quota nahi khata.");
      var me2 = await api("/api/me");
      state.sites = me2.sites || [];
      paintSites();
    } catch (e) {
      setErr("pubErr", e.message);
      setStatus(2, "");
    } finally { lock(false); }
  }

  // ---------------- edit an existing site ----------------
  async function openSite(slug) {
    try {
      var d = await api("/api/site/" + slug);
      var site = d.site;
      state.slug = site.slug;
      state.prompt = site.prompt || "";
      state.brief = site.brief || null;
      state.pages = site.pages || [];
      state.active = 0;
      state.undo = [];
      state.editsLeft = typeof site.editsLeft === "number" ? site.editsLeft : null;
      $("prompt").value = state.prompt;
      $("tweak").value = "";
      setErr("artErr", ""); setErr("buildErr", ""); setErr("pubErr", "");
      if (state.brief) { paintBrief(state.brief); show($("briefCard"), true); }
      showPreview(state.pages);
      show($("previewCard"), true);
      show($("linkBox"), false);
      paintVersions(site.versions || []);
      $("btnPub").textContent = "Update site";
      show($("editBar"), true);
      paintEdits();
      setStatus(2, "Site edit ho rahi hai. Change karo, phir Update dabao.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      alert(e.message);
    }
  }

  function paintVersions(list) {
    var box = $("versions");
    if (!list || !list.length) { show(box, false); box.innerHTML = ""; return; }
    box.innerHTML = list.map(function (v, i) {
      var t = (v.at || "").slice(11, 16);
      var day = (v.at || "").slice(5, 10);
      return '<button class="v" data-id="' + v.id + '" onclick="restoreVer(this.dataset.id)">v' +
        (list.length - i) + " · " + day + " " + t + "</button>";
    }).join("");
    show(box, true);
  }

  async function restoreVer(id) {
    if (!confirm("Ye purana version preview mein load karein? Live site tab tak nahi badlegi jab tak Update na dabao.")) return;
    try {
      var d = await api("/api/restore", { slug: state.slug, id: id });
      state.undo.push(clonePages());
      state.pages = d.pages || [];
      state.active = 0;
      showPreview(state.pages);
      setStatus(2, "Purana version load ho gaya. Update dabao to live ho jayega.");
    } catch (e) { alert(e.message); }
  }

  function undoEdit() {
    if (!state.undo.length) { setStatus(2, "Undo ke liye kuch nahi hai."); return; }
    state.pages = state.undo.pop();
    state.active = 0;
    showPreview(state.pages);
    setStatus(2, "Ek step peeche aa gaye.");
  }

  function newSite() {
    if (!confirm("Naya site shuru karein? Abhi wali edit band ho jayegi (live site par asar nahi padega).")) return;
    state.slug = null;
    state.pages = [];
    state.brief = null;
    state.prompt = "";
    state.undo = [];
    state.active = 0;
    state.editsLeft = null;
    $("prompt").value = "";
    $("tweak").value = "";
    show($("briefCard"), false);
    show($("previewCard"), false);
    show($("linkBox"), false);
    show($("editBar"), false);
    paintVersions([]);
    $("btnPub").textContent = "Publish karo";
    setStatus(1, ""); setStatus(2, "");
    setErr("artErr", ""); setErr("buildErr", ""); setErr("pubErr", "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function delSite(slug) {
    if (!confirm("Ye site delete karni hai? Link kaam karna band kar dega.")) return;
    try {
      await api("/api/delete", { slug: slug });
      state.sites = state.sites.filter(function (s) { return s.slug !== slug; });
      if (state.slug === slug) newSite();
      paintSites();
    } catch (e) { alert(e.message); }
  }

  boot();
</script>
</body>
</html>`;

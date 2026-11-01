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
  maxPages: 2,       // pages per site - 2 is safe on the free plan, raise it if you upgrade
  gensPerDay: 20,    // hard safety net on AI calls
  otpPerEmail: 5,    // OTP requests per email per day
  mailsPerDay: 100,  // global cap on outbound OTP mails
};

const COOKIE = "kv_session";

// Bump this whenever the code changes - it is how you confirm what is live.
const BUILD_ID = "kovik-2026-11-02-a";

// Daily caps. Override any of these with plain-text variables in the dashboard:
// SITES_PER_DAY, GENS_PER_DAY, OTP_PER_EMAIL, MAILS_PER_DAY
function L(env) {
  const num = (v, d) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : d;
  };
  return {
    dailyOps: num(env.DAILY_LIMIT, LIMITS.dailyOps),
    maxPages: num(env.MAX_PAGES, LIMITS.maxPages),
    gensPerDay: num(env.GENS_PER_DAY, LIMITS.gensPerDay),
    otpPerEmail: num(env.OTP_PER_EMAIL, LIMITS.otpPerEmail),
    mailsPerDay: num(env.MAILS_PER_DAY, LIMITS.mailsPerDay)
  };
}

// ---------------------------------------------------------------------------
//  CONFIG
//  Secrets can come from the dashboard OR from the admin panel (stored in KV).
//  KV wins, so you can change keys from your phone without redeploying.
// ---------------------------------------------------------------------------
async function readConfig(env) {
  let saved = {};
  try {
    const raw = await env.SITES.get("cfg:main");
    if (raw) saved = JSON.parse(raw);
  } catch (e) {
    saved = {};
  }
  return saved;
}

function adminEmail(env) {
  return String(env.ADMIN_EMAIL || "rrsinha378@gmail.com").trim().toLowerCase();
}

async function withConfig(env) {
  const c = await readConfig(env);
  const merged = Object.assign({}, env);
  if (c.aiKey) merged.GEMINI_KEY = c.aiKey;
  if (c.gmailUser) merged.GMAIL_USER = c.gmailUser;
  if (c.gmailPass) merged.GMAIL_APP_PASSWORD = c.gmailPass;
  if (c.brevoKey) merged.BREVO_KEY = c.brevoKey;
  if (c.mailFrom) merged.MAIL_FROM = c.mailFrom;
  if (c.watermarkUrl) merged.WATERMARK_URL = c.watermarkUrl;
  if (c.dailyLimit) merged.DAILY_LIMIT = String(c.dailyLimit);
  if (c.maxPages) merged.MAX_PAGES = String(c.maxPages);
  return merged;
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
      if (request.method === "GET" && path === "/api/self-test") return selfTest(env);
      if (request.method === "GET" && path === "/api/admin") return adminGet(request, env);
      if (request.method === "POST" && path === "/api/admin/save") return adminSave(request, env);
      if (request.method === "POST" && path === "/api/admin/test-ai") return adminTestAi(request, env);
      if (request.method === "POST" && path === "/api/admin/test-mail") return adminTestMail(request, env);
      if (request.method === "GET" && path === "/api/version") {
        return json({ build: BUILD_ID, engine: ENGINE_LABEL });
      }
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
      const status = err && err.status ? err.status : 500;
      console.error("request failed:", (err && err.stack) || err);
      return json({ error: scrub(String((err && err.message) || err)) }, status);
    }
  }
};

// ============================================================================
//  SMALL UTILITIES
// ============================================================================

// Measures how much CPU the heavy path costs, using fake pages of a realistic
// size. Free Workers get 10ms of CPU per request; anything near that is the
// reason a build returns a bare 500 with no message.
function selfTest(env) {
  const chunk = "<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor.</p>";
  const measure = (pageCount) => {
    const body = "<!DOCTYPE html><html><head><title>t</title></head><body>" +
      chunk.repeat(320) + "</body></html>";
    const parts = [];
    const names = ["index.html|Home", "about.html|About", "contact.html|Contact"];
    for (let i = 0; i < pageCount; i++) parts.push("===PAGE:" + names[i] + "===\n" + body);
    const envelope = JSON.stringify({ candidates: [{ content: { parts: [{ text: parts.join("\n") }] } }] });

    const t0 = performance.now();
    const data = JSON.parse(envelope);
    const text = data.candidates[0].content.parts[0].text;
    const pages = normalizePages(parsePages(text), env);
    const out = JSON.stringify({ pages });
    const ms = performance.now() - t0;

    return {
      pages: pages.length,
      inputKB: Math.round(envelope.length / 1024),
      outputKB: Math.round(out.length / 1024),
      cpuMs: Math.round(ms * 100) / 100
    };
  };

  // warm up once so the numbers are not first-run noise
  measure(2);
  const two = measure(2);
  const three = measure(3);

  return json({
    build: BUILD_ID,
    freeplanLimitMs: 10,
    twoPages: two,
    threePages: three,
    verdict:
      three.cpuMs > 9
        ? "3 pages is too heavy on the free plan - set MAX_PAGES=2"
        : three.cpuMs > 6
        ? "3 pages is close to the limit - MAX_PAGES=2 is safer"
        : "ok"
  });
}

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
  env = await withConfig(env);
  const day = today();
  const slot = await bump(env, "mail:" + day, L(env).mailsPerDay);
  if (!slot.ok) throw new Error("The daily email limit has been reached. Try again tomorrow.");

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
    throw new Error("Email could not be sent: " + text.slice(0, 200));
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
      return wrapRawSocket(secure);
    },
    close() {
      try { raw.close(); } catch (e) {}
    }
  };
}

async function workerSocket(host, port) {
  const mod = await import("cloudflare:sockets");
  // secureTransport: "starttls" is REQUIRED - without it Cloudflare refuses
  // to upgrade the plain socket, and startTls() throws.
  // NOTE: secureTransport is the SECOND argument, not part of the address.
  // connect({hostname,port}, {secureTransport:"starttls"}) - anything else
  // and startTls() throws "secureTransport socket option must be set to starttls".
  return wrapRawSocket(
    mod.connect({ hostname: host, port }, { secureTransport: "starttls", allowHalfOpen: false })
  );
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
    if (chunk === null) throw new Error("The SMTP connection closed unexpectedly.");
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
    <p style="color:#8b95a8;font-size:14px;margin:0 0 20px">This code is valid for 10 minutes. Do not share it with anyone.</p>
    <div style="font-size:34px;font-weight:700;letter-spacing:10px;background:#151922;border:1px solid #242a37;border-radius:12px;padding:18px;text-align:center">${code}</div>
    <p style="color:#8b95a8;font-size:12px;margin:22px 0 0">If you did not request this, you can safely ignore this email.</p>
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

  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);

  const allow = String(env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => normEmail(e))
    .filter(Boolean);
  if (allow.length && !allow.includes(email)) {
    return json({ error: "This email is not allowed to use this builder." }, 403);
  }

  const perEmail = await bump(env, "otpreq:" + email + ":" + today(), L(env).otpPerEmail);
  if (!perEmail.ok) return json({ error: "You can request at most " + L(env).otpPerEmail + " codes per day for this email." }, 429);

  const code = digits(6);
  await env.SITES.put("otp:" + email, JSON.stringify({ code, tries: 0 }), { expirationTtl: 600 });

  try {
    await sendMail(env, email, code + " - your " + BRAND.product + " login code", otpMail(code));
  } catch (err) {
    return json({ error: String(err.message || err) }, 502);
  }

  return json({ ok: true, sentTo: email });
}

async function verifyOtp(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = normEmail(body.email);
  const code = String(body.code || "").replace(/\D/g, "");

  if (!validEmail(email) || code.length !== 6) return json({ error: "Email or code is incomplete." }, 400);

  const key = "otp:" + email;
  const raw = await env.SITES.get(key);
  if (!raw) return json({ error: "This code has expired. Request a new one." }, 400);

  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return json({ error: "This code has expired. Request a new one." }, 400);
  }

  if (rec.tries >= 5) {
    await env.SITES.delete(key);
    return json({ error: "Too many incorrect attempts. Request a new code." }, 429);
  }

  if (rec.code !== code) {
    rec.tries += 1;
    await env.SITES.put(key, JSON.stringify(rec), { expirationTtl: 600 });
    return json({ error: "That code is incorrect." }, 400);
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
  env = await withConfig(env);
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
//  ADMIN  -  paste keys from the browser, no dashboard needed
// ============================================================================

async function requireAdmin(request, env) {
  const user = await currentUser(request, env);
  if (!user) return { error: json({ error: "Login required." }, 401) };
  if (String(user.email).toLowerCase() !== adminEmail(env)) {
    return { error: json({ error: "This account is not the admin." }, 403) };
  }
  return { user };
}

function mask(value) {
  const v = String(value || "");
  if (!v) return null;
  return v.length <= 4 ? "••••" : "••••" + v.slice(-4);
}

async function adminGet(request, env) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;

  const c = await readConfig(env);
  const merged = await withConfig(env);

  let kvOk = true;
  try {
    await env.SITES.get("cfg:main");
  } catch (e) {
    kvOk = false;
  }

  return json({
    admin: true,
    build: BUILD_ID,
    kvOk,
    engine: ENGINE_LABEL,
    config: {
      aiKey: mask(merged.GEMINI_KEY),
      gmailUser: merged.GMAIL_USER || null,
      gmailPass: mask(merged.GMAIL_APP_PASSWORD),
      brevo: mask(merged.BREVO_KEY),
      mailFrom: merged.MAIL_FROM || "rrsinha378@gmail.com",
      watermarkUrl: merged.WATERMARK_URL || "https://kovik.netlify.app",
      dailyLimit: L(merged).dailyOps,
      maxPages: L(merged).maxPages,
      gensPerDay: L(merged).gensPerDay
    },
    fromPanel: Object.keys(c).length > 0
  });
}

async function adminSave(request, env) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => ({}));
  const c = await readConfig(env);

  const setIf = (k, v) => {
    const val = String(v == null ? "" : v).trim();
    if (val) c[k] = val;
  };

  setIf("aiKey", body.aiKey);
  setIf("gmailUser", body.gmailUser);
  setIf("gmailPass", body.gmailPass);
  setIf("brevoKey", body.brevoKey);
  setIf("mailFrom", body.mailFrom);
  setIf("watermarkUrl", body.watermarkUrl);
  if (body.dailyLimit) c.dailyLimit = Math.max(1, Math.min(1000, Number(body.dailyLimit) || 3));
  if (body.maxPages) c.maxPages = Math.max(1, Math.min(4, Number(body.maxPages) || 2));

  if (body.clear === "aiKey") delete c.aiKey;
  if (body.clear === "gmailPass") delete c.gmailPass;
  if (body.clear === "brevoKey") delete c.brevoKey;

  await env.SITES.put("cfg:main", JSON.stringify(c));
  return json({ ok: true, saved: Object.keys(c) });
}

async function adminTestAi(request, env) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  env = await withConfig(env);
  try {
    const out = await callModel(env, "Reply with the single word: ok", false, 20);
    return json({ ok: true, reply: String(out).trim().slice(0, 60) });
  } catch (err) {
    return json({ ok: false, error: scrub(String((err && err.message) || err)) }, 200);
  }
}

async function adminTestMail(request, env) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  env = await withConfig(env);
  const body = await request.json().catch(() => ({}));
  const to = normEmail(body.to) || adminEmail(env);
  try {
    await sendMail(env, to, "Kovik Intelligence - test email",
      '<div style="font-family:system-ui;padding:24px"><h2>Email is working</h2>' +
      "<p>This is a test message from your admin panel.</p></div>");
    return json({ ok: true, to });
  } catch (err) {
    return json({ ok: false, error: scrub(String((err && err.message) || err)) }, 200);
  }
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
  env = await withConfig(env);
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => ({}));
  const prompt = String(body.prompt || "").trim();
  if (prompt.length < 10) return json({ error: "Describe your idea in a little more detail." }, 400);

  const slot = await bump(env, "gen:" + gate.user.email + ":" + today(), L(env).gensPerDay);
  if (!slot.ok) return json({ error: "The daily AI limit (" + L(env).gensPerDay + " calls) has been reached. Try again tomorrow." }, 429);

  const raw = await callModel(env, ART_RULES + "\n\nBusiness idea:\n" + prompt, true);

  let brief;
  try {
    brief = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return json({ error: "The model did not return a usable answer. Please try again." }, 502);
    try {
      brief = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return json({ error: "The design brief could not be read. Please try again." }, 502);
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
- Keep every page lean: aim for under about 15 KB of HTML per page. Concise beats padded.
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
    if (String(p.html || "").indexOf("href=") === -1) return; // nothing to repair
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
  return fixed.slice(0, L(env).maxPages);
}

// The free Workers plan allows 10ms of CPU per request. Processing scales with
// the size of the model output, so we hard-bound it here: anything past this
// budget is dropped rather than allowed to blow the CPU limit and 500.
const MAX_TOTAL_KB = 64;

function boundPages(pages) {
  const kept = [];
  let total = 0;
  for (const p of pages) {
    const size = String(p.html || "").length;
    if (kept.length && total + size > MAX_TOTAL_KB * 1024) break;
    kept.push(p);
    total += size;
  }
  return kept.length ? kept : pages.slice(0, 1);
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
    "<h1>404</h1><p style=\"color:#8b95a8\">This page does not exist.</p>" +
    '<p><a href="/" style="color:#6d8cff">Kovik Intelligence</a></p></body>'
  );
}

async function buildStage(request, env) {
  env = await withConfig(env);
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => ({}));
  const prompt = String(body.prompt || "").trim();
  const brief = body.brief ? JSON.stringify(body.brief, null, 2) : "";
  const prevPages = Array.isArray(body.pages) ? body.pages : [];
  const instruction = String(body.instruction || "").trim();
  const slug = String(body.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");

  const refining = prevPages.length > 0 && instruction.length > 0;
  if (!refining && !brief) return json({ error: "Create a design brief first." }, 400);

  let editsLeft = null;
  if (refining) {
    const cap = L(env).dailyOps;
    const slot = await bump(env, opsKey(gate.user.email), cap);
    if (!slot.ok) {
      return json(
        {
          error:
            "All " + cap + " operations for today are used. A new site costs 1, an edit costs 1. " +
            "The quota resets at midnight IST."
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
    return json({ error: "The daily AI limit (" + L(env).gensPerDay + " calls) has been reached. Try again tomorrow." }, 429);
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

  const raw = await callModel(env, task, false, refining ? 7000 : 8000);
  const parsed = normalizePages(boundPages(parsePages(raw)), env, { full: !refining });

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
  if (out.indexOf("```") !== -1) {
    out = out.replace(/^```(?:html)?/i, "").replace(/```$/, "").trim();
  }
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
class ModelError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 502;
  }
}

async function callModel(env, prompt, wantJson, maxOut) {
  env = await withConfig(env);
  // One retry for a transient upstream failure, then give up.
  try {
    return await callModelOnce(env, prompt, wantJson, maxOut);
  } catch (err) {
    if (err && err.retryable) {
      await new Promise((r) => setTimeout(r, 800));
      return await callModelOnce(env, prompt, wantJson, maxOut);
    }
    throw err;
  }
}

async function callModelOnce(env, prompt, wantJson, maxOut) {
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
    if (!res.ok) {
      const e = new ModelError("The AI service returned HTTP " + res.status + ".", 502);
      e.retryable = res.status === 429 || res.status >= 500;
      throw e;
    }
    const data = await res.json();
    if (data.error) {
      const e = new ModelError(scrub(data.error.message || "The AI service returned an error."), 502);
      e.retryable = data.error.code === 429 || data.error.code === 503;
      throw e;
    }
    const text = data.choices && data.choices[0] && data.choices[0].message.content;
    if (!text) throw new Error("model returned nothing");
    return text;
  }

  if (!env.GEMINI_KEY) throw new ModelError("The AI service is not configured.", 503);

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
  if (data.error) {
    const e = new ModelError(scrub(data.error.message || "The AI service returned an error."), 502);
    e.retryable = data.error.code === 429 || data.error.code === 503;
    throw e;
  }

  const parts =
    (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || "").join("");
  if (!text.trim()) throw new Error("The model returned an empty answer. Please try again.");
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
  env = await withConfig(env);
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => ({}));
  const incoming = incomingPages(body);
  if (!incoming.length) return json({ error: "There is nothing to publish." }, 400);

  const pages = normalizePages(incoming, env);

  const slot = await bump(env, opsKey(gate.user.email), L(env).dailyOps);
  if (!slot.ok) {
    return json(
      {
        error:
          "All " + L(env).dailyOps + " operations for today are used. A new site costs 1, an edit costs 1. " +
          "The quota resets at midnight IST."
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
  if (!rec) return json({ error: "Site not found." }, 404);

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
  env = await withConfig(env);
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => ({}));
  const slug = String(body.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!slug) return json({ error: "slug missing" }, 400);

  const incoming = incomingPages(body);
  if (!incoming.length) return json({ error: "There is nothing to update." }, 400);

  const rec = await ownedSite(env, gate.user.email, slug);
  if (!rec) return json({ error: "Site not found." }, 404);

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
  if (!slug || !id) return json({ error: "slug or version is missing" }, 400);

  const rec = await ownedSite(env, gate.user.email, slug);
  if (!rec) return json({ error: "Site not found." }, 404);

  const raw = await env.SITES.get("ver:" + slug + ":" + id);
  if (!raw) return json({ error: "That version is no longer available." }, 404);

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
  if (!pages.length) return json({ error: "That version is empty." }, 404);

  return json({ pages });
}

async function removeSite(request, env) {
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => ({}));
  const slug = String(body.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!slug) return json({ error: "slug missing" }, 400);

  const raw = await env.SITES.get("site:" + slug);
  if (!raw) return json({ error: "Site not found." }, 404);

  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return json({ error: "Site not found." }, 404);
  }
  if (rec.email !== gate.user.email) return json({ error: "This site does not belong to you." }, 403);

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
  return html(SHELL.replace("__BUILD__", BUILD_ID));
}

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0b10">
<title>Kovik Intelligence — AI Website Builder</title>
<meta name="description" content="Kovik Intelligence AI Coder — describe a business, approve the design, publish a website. Powered by Kovik Digital Solutions, Hajipur.">
<style>
  :root{
    --bg:#0a0b10; --bg2:#0e1017; --card:#12141d; --card2:#171a25;
    --line:#232838; --line2:#2e3547;
    --ink:#eef1f7; --dim:#9aa3b8; --faint:#646d82;
    --acc:#6f7bff; --acc2:#a855f7; --accInk:#0a0b10;
    --ok:#34d399; --bad:#ff6b6b; --warn:#fbbf24;
    --r:16px;
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  body{min-height:100dvh;
    background:
      radial-gradient(900px 420px at 12% -8%, rgba(111,123,255,.16), transparent 70%),
      radial-gradient(700px 380px at 92% 4%, rgba(168,85,247,.13), transparent 70%),
      var(--bg);
  }
  a{color:var(--acc)}
  .wrap{max-width:820px;margin:0 auto;padding:0 16px 56px}

  /* ---------- top bar ---------- */
  .top{display:flex;align-items:center;gap:11px;padding:16px 0 12px}
  .mark{width:38px;height:38px;border-radius:12px;flex:none;display:grid;place-items:center;
    background:linear-gradient(140deg,var(--acc),var(--acc2));color:#fff;font-weight:800;font-size:16px;
    box-shadow:0 6px 20px rgba(111,123,255,.35)}
  .brand b{display:block;font-size:15px;letter-spacing:.1px;line-height:1.2}
  .brand span{display:block;font-size:10.5px;color:var(--faint);letter-spacing:.9px;text-transform:uppercase}
  .user{margin-left:auto;display:flex;align-items:center;gap:8px}
  .avatar{width:30px;height:30px;border-radius:50%;background:var(--card2);border:1px solid var(--line);
    display:grid;place-items:center;font-size:12px;color:var(--dim);text-transform:uppercase}

  /* ---------- nav ---------- */
  .nav{display:flex;gap:6px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:5px;margin:4px 0 18px}
  .nav button{flex:1;min-height:38px;border:0;border-radius:10px;background:transparent;color:var(--dim);
    font:inherit;font-weight:600;font-size:13px;cursor:pointer;transition:.15s}
  .nav button.on{background:linear-gradient(140deg,var(--acc),var(--acc2));color:#fff;
    box-shadow:0 4px 16px rgba(111,123,255,.28)}

  /* ---------- generic ---------- */
  h1{font-size:25px;line-height:1.22;margin:22px 0 8px;letter-spacing:-.5px}
  .lede{color:var(--dim);margin:0 0 20px;font-size:14.5px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px;margin:0 0 14px}
  .card.flat{background:var(--card2)}
  .stephead{display:flex;align-items:center;gap:9px;margin:0 0 12px}
  .num{width:22px;height:22px;border-radius:7px;flex:none;display:grid;place-items:center;font-size:11.5px;
    font-weight:700;background:rgba(111,123,255,.16);color:var(--acc);border:1px solid rgba(111,123,255,.3)}
  .stephead h2{font-size:15px;margin:0;letter-spacing:-.1px}
  label{display:block;font-size:11.5px;color:var(--faint);margin:0 0 6px;letter-spacing:.5px;text-transform:uppercase}
  input,textarea,select{width:100%;background:var(--bg2);color:var(--ink);border:1px solid var(--line);
    border-radius:12px;padding:13px;font:inherit;outline:none;transition:.15s}
  input:focus,textarea:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(111,123,255,.13)}
  textarea{min-height:96px;resize:vertical}
  .row{display:flex;gap:9px;flex-wrap:wrap;margin-top:12px}
  .row>button{flex:1 1 0;min-width:120px}
  button{min-height:46px;padding:0 16px;border-radius:12px;border:1px solid var(--line);
    background:var(--card2);color:var(--ink);font:inherit;font-weight:600;cursor:pointer;transition:.12s}
  button:active{transform:scale(.985)}
  button.primary{background:linear-gradient(140deg,var(--acc),var(--acc2));border-color:transparent;color:#fff;
    box-shadow:0 6px 20px rgba(111,123,255,.3)}
  button.ghost{background:transparent}
  button.danger{color:var(--bad);border-color:#3a2430}
  button:disabled{opacity:.45;cursor:default;transform:none;box-shadow:none}
  button.sm{min-height:34px;padding:0 11px;font-size:12px;border-radius:9px;flex:none;min-width:0}
  .hint{font-size:12px;color:var(--faint);margin:9px 0 0}
  .status{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dim);min-height:20px;margin:0 0 12px}
  .spin{width:9px;height:9px;border-radius:50%;background:var(--acc);animation:pulse 1s infinite}
  @keyframes pulse{0%,100%{opacity:.2}50%{opacity:1}}
  .err{color:var(--bad);font-size:13px;margin:9px 0 0;line-height:1.5}
  .okmsg{color:var(--ok);font-size:13px;margin:9px 0 0}

  .chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
  .chip{font-size:11.5px;color:var(--dim);background:var(--card);border:1px solid var(--line);
    border-radius:999px;padding:6px 12px}
  .chip b{color:var(--ink)}

  /* ---------- brief ---------- */
  .swatches{display:flex;gap:8px;margin:12px 0}
  .sw{width:40px;height:40px;border-radius:11px;border:1px solid rgba(255,255,255,.15)}
  .kv{display:flex;gap:10px;font-size:13px;padding:8px 0;border-top:1px solid var(--line)}
  .kv span{color:var(--faint);min-width:78px;flex:none}
  .sections{list-style:none;margin:10px 0 0;padding:0;counter-reset:s}
  .sections li{counter-increment:s;position:relative;padding:9px 0 9px 30px;border-top:1px solid var(--line);font-size:13px}
  .sections li:before{content:counter(s);position:absolute;left:0;top:10px;width:20px;height:20px;border-radius:6px;
    background:var(--card2);border:1px solid var(--line);display:grid;place-items:center;font-size:10.5px;color:var(--dim)}
  .sections b{display:block;font-size:13px}
  .sections em{color:var(--dim);font-style:normal;font-size:12.5px}

  /* ---------- preview ---------- */
  .tabs{display:flex;gap:7px;overflow-x:auto;padding:0 0 10px;-webkit-overflow-scrolling:touch}
  .tabs::-webkit-scrollbar{display:none}
  .tab{flex:none;min-height:33px;padding:0 13px;border-radius:9px;font-size:12.5px;font-weight:600;
    background:var(--card2);border:1px solid var(--line);color:var(--dim);cursor:pointer}
  .tab.on{background:rgba(111,123,255,.16);border-color:rgba(111,123,255,.45);color:var(--ink)}
  .ptool{display:flex;align-items:center;gap:7px;margin:0 0 10px;flex-wrap:wrap}
  .ptool .spacer{flex:1}
  .seg{display:flex;background:var(--bg2);border:1px solid var(--line);border-radius:9px;padding:3px;gap:2px}
  .seg button{min-height:28px;padding:0 10px;font-size:11.5px;border:0;background:transparent;color:var(--dim);border-radius:7px;min-width:0}
  .seg button.on{background:var(--card2);color:var(--ink);box-shadow:0 1px 0 rgba(255,255,255,.04)}
  .sandboxbadge{font-size:10.5px;color:var(--faint);border:1px solid var(--line);border-radius:999px;padding:4px 9px;
    display:inline-flex;align-items:center;gap:5px}
  .sandboxbadge i{width:5px;height:5px;border-radius:50%;background:var(--ok);display:block}
  .stage{background:#0b0d12;border:1px solid var(--line);border-radius:14px;padding:10px;overflow:auto}
  .frame{width:100%;height:58vh;min-height:340px;border:0;border-radius:9px;background:#fff;display:block;
    margin:0 auto;transition:width .2s ease}
  .empty{display:grid;place-items:center;height:340px;color:var(--faint);font-size:13px;text-align:center;padding:24px}

  .linkbox{background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:13px;font-size:13px;
    word-break:break-all;margin:12px 0 0}
  .linkbox a{font-weight:600}

  /* ---------- lists ---------- */
  .sitelist{list-style:none;margin:0;padding:0}
  .sitelist li{display:flex;align-items:center;gap:9px;padding:12px 0;border-top:1px solid var(--line);font-size:13px}
  .sitelist li:first-child{border-top:0}
  .sitelist a{flex:1;text-decoration:none;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sitelist small{color:var(--faint);font-size:11px;display:block;margin-top:2px}

  /* ---------- admin ---------- */
  .sectitle{font-size:11.5px;letter-spacing:1px;text-transform:uppercase;color:var(--faint);margin:22px 0 10px}
  .field{margin:0 0 12px}
  .field .lbl{display:flex;align-items:center;gap:8px;margin:0 0 6px}
  .field .lbl label{margin:0}
  .badge{font-size:10px;border-radius:999px;padding:3px 8px;border:1px solid var(--line);color:var(--faint)}
  .badge.set{color:var(--ok);border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.08)}
  .badge.unset{color:var(--warn);border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.07)}
  .stat{display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:9px 0;border-top:1px solid var(--line)}
  .stat span{color:var(--faint)}
  .stat b{font-weight:600}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  @media(max-width:420px){.grid2{grid-template-columns:1fr}}

  footer{margin-top:28px;padding-top:16px;border-top:1px solid var(--line);color:var(--faint);font-size:11.5px;line-height:1.75}
  footer b{color:var(--dim);font-weight:600}
  .hide{display:none!important}
</style>
</head>
<body>
<div class="wrap">

  <div class="top">
    <div class="mark">K</div>
    <div class="brand">
      <b>Kovik Intelligence</b>
      <span>AI Coder</span>
    </div>
    <div class="user hide" id="userBox">
      <div class="avatar" id="avatar">?</div>
      <button class="sm" onclick="doLogout()">Log out</button>
    </div>
  </div>

  <!-- ================= LOGIN ================= -->
  <section id="login">
    <h1>Your website, from one idea.</h1>
    <p class="lede">Describe the business. We plan the design direction first, you approve it, then the pages are written and published.</p>

    <div class="card">
      <div class="field">
        <label for="email">Email</label>
        <input id="email" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com">
      </div>
      <div class="row">
        <button class="primary" id="btnOtp" onclick="askOtp()">Send login code</button>
      </div>

      <div id="otpStep" class="hide" style="margin-top:16px">
        <div class="field">
          <label for="code">6-digit code</label>
          <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
        </div>
        <div class="row">
          <button class="primary" id="btnVerify" onclick="verify()">Log in</button>
          <button class="ghost" onclick="askOtp()">Resend</button>
        </div>
        <p class="hint">The code is valid for 10 minutes.</p>
      </div>

      <div class="err hide" id="loginErr"></div>
    </div>

    <p class="hint">3 operations per day. A new site costs 1, an edit costs 1. Resets at midnight IST.</p>
  </section>

  <!-- ================= APP ================= -->
  <section id="app" class="hide">

    <div class="nav" id="nav">
      <button class="on" data-view="build" onclick="goView('build')">Builder</button>
      <button data-view="sites" onclick="goView('sites')">My sites</button>
      <button data-view="admin" id="navAdmin" onclick="goView('admin')">Admin</button>
    </div>

    <div class="chips" id="chips"></div>

    <!-- ---------- BUILD ---------- -->
    <div id="view-build">
      <div class="card">
        <div class="stephead"><div class="num">1</div><h2>Describe the business</h2></div>
        <textarea id="prompt" placeholder="e.g. a dental clinic in Hajipur. Services, timings, WhatsApp booking, English and Hindi. Should feel calm and trustworthy."></textarea>
        <div class="row">
          <button class="primary" id="btnArt" onclick="runArt()">Create design direction</button>
        </div>
        <p class="hint">This step plans first — colours, fonts, sections, real copy — then the code is written.</p>
        <div class="err hide" id="artErr"></div>
      </div>

      <div class="status" id="status1"><span id="spin1" class="spin hide"></span><span id="msg1"></span></div>

      <div class="card hide" id="briefCard">
        <div class="stephead"><div class="num">2</div><h2>Design direction — approve it</h2></div>
        <div id="briefBody"></div>
        <div class="row">
          <button class="primary" id="btnBuild" onclick="runBuild()">Approve — build the site</button>
          <button class="ghost" onclick="runArt()">Reconsider</button>
        </div>
        <div class="err hide" id="buildErr"></div>
      </div>

      <div class="status" id="status2"><span id="spin2" class="spin hide"></span><span id="msg2"></span></div>

      <div class="card hide" id="previewCard">
        <div class="stephead"><div class="num">3</div><h2>Preview</h2></div>
        <div class="editbar hide" id="editBar" style="display:flex;align-items:center;gap:8px;background:rgba(111,123,255,.09);border:1px solid rgba(111,123,255,.3);border-radius:11px;padding:9px 11px;font-size:12px;color:var(--dim);margin:0 0 12px">
          Editing <b id="editName" style="color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1"></b>
          <button class="sm" onclick="newSite()">New site</button>
        </div>

        <div class="tabs hide" id="pageTabs"></div>

        <div class="ptool">
          <div class="seg" id="devSeg">
            <button class="on" data-w="390" onclick="setDevice(390,this)">Phone</button>
            <button data-w="768" onclick="setDevice(768,this)">Tablet</button>
            <button data-w="0" onclick="setDevice(0,this)">Full</button>
          </div>
          <span class="spacer"></span>
          <span class="sandboxbadge"><i></i>sandboxed</span>
          <button class="sm" id="btnOpen" onclick="openInTab()">Open</button>
        </div>

        <div class="stage">
          <iframe id="frame" class="frame" sandbox="allow-scripts allow-forms allow-popups allow-modals" title="preview"></iframe>
          <div class="empty" id="empty">Your site appears here</div>
        </div>

        <div class="field" style="margin-top:14px">
          <label for="tweak">Want a change?</label>
          <textarea id="tweak" style="min-height:64px" placeholder="e.g. make the hero bigger, add a pricing section, warm up the accent"></textarea>
        </div>
        <div class="row">
          <button id="btnRefine" onclick="runRefine()">Apply change</button>
          <button class="primary" id="btnPub" onclick="runPublish()">Publish</button>
          <button id="btnUndo" onclick="undoEdit()">Undo</button>
        </div>
        <div class="vers hide" id="versions" style="display:flex;gap:7px;flex-wrap:wrap;margin:12px 0 0"></div>
        <p class="hint" id="pubHint"></p>
        <div class="err hide" id="pubErr"></div>
        <div class="linkbox hide" id="linkBox"></div>
      </div>
    </div>

    <!-- ---------- SITES ---------- -->
    <div id="view-sites" class="hide">
      <div class="card">
        <div class="stephead"><div class="num">·</div><h2>My sites</h2></div>
        <ul class="sitelist" id="siteList"><li style="color:var(--faint);font-size:13px">Nothing yet.</li></ul>
      </div>
    </div>

    <!-- ---------- ADMIN ---------- -->
    <div id="view-admin" class="hide">
      <div class="card flat">
        <div class="stephead"><div class="num">⚙</div><h2>Admin panel</h2></div>
        <p class="hint" style="margin-top:0">Paste your keys here once. They are stored server-side and never sent back to the browser.</p>
        <div id="adminStatus"></div>
      </div>

      <div class="sectitle">AI engine</div>
      <div class="card">
        <div class="field">
          <div class="lbl"><label for="aAiKey">API key</label><span class="badge" id="badgeAi">checking</span></div>
          <input id="aAiKey" type="password" autocomplete="off" placeholder="paste the key here">
        </div>
        <div class="row">
          <button class="primary" id="btnSaveKeys" onclick="saveAdmin()">Save keys</button>
          <button onclick="testAi()">Test AI</button>
        </div>
        <div class="okmsg hide" id="aiOk"></div>
        <div class="err hide" id="aiErr"></div>
      </div>

      <div class="sectitle">Email (login codes)</div>
      <div class="card">
        <div class="field">
          <div class="lbl"><label for="aMailUser">Gmail address</label><span class="badge" id="badgeUser">checking</span></div>
          <input id="aMailUser" type="email" autocomplete="off" placeholder="you@gmail.com">
        </div>
        <div class="field">
          <div class="lbl"><label for="aMailPass">App password</label><span class="badge" id="badgePass">checking</span></div>
          <input id="aMailPass" type="password" autocomplete="off" placeholder="16 characters, no spaces needed">
        </div>
        <div class="row">
          <button id="btnSaveMail" onclick="saveAdmin()">Save keys</button>
          <button onclick="testMail()">Send test email</button>
        </div>
        <div class="okmsg hide" id="mailOk"></div>
        <div class="err hide" id="mailErr"></div>
      </div>

      <div class="sectitle">Limits</div>
      <div class="card">
        <div class="grid2">
          <div class="field">
            <label for="aDaily">Operations per day</label>
            <input id="aDaily" type="number" min="1" max="1000" placeholder="3">
          </div>
          <div class="field">
            <label for="aPages">Pages per site</label>
            <input id="aPages" type="number" min="1" max="4" placeholder="2">
          </div>
        </div>
        <p class="hint">On the free plan keep pages at 2. Raise it only if you upgrade.</p>
        <div class="row"><button class="primary" id="btnSaveLimits" onclick="saveAdmin()">Save limits</button></div>
      </div>

      <div class="sectitle">Status</div>
      <div class="card">
        <div class="stat"><span>Build</span><b id="sBuild">—</b></div>
        <div class="stat"><span>Engine</span><b id="sEngine">—</b></div>
        <div class="stat"><span>Storage</span><b id="sKv">—</b></div>
        <div class="stat"><span>Keys saved from panel</span><b id="sPanel">—</b></div>
      </div>
    </div>
  </section>

  <footer>
    <b>Kovik Intelligence AI Coder</b> — AI Website Builder<br>
    Powered by <b>Kovik Digital Solutions</b> · Hajipur, Bihar<br>
    Build <span id="buildId">__BUILD__</span>
  </footer>
</div>

<script>
  var state = { user:null, isAdmin:false, brief:null, prompt:"", usage:null, sites:[], slug:null,
                pages:[], active:0, undo:[], opsLeft:null, view:"build", device:390 };

  function $(id){ return document.getElementById(id); }
  function show(el,on){ if(el) el.classList.toggle("hide", !on); }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){
    return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
  function clonePages(){ return JSON.parse(JSON.stringify(state.pages||[])); }

  function setStatus(n,text,busy){ show($("spin"+n),busy); $("msg"+n).textContent=text||""; }
  function setErr(id,text){ var el=$(id); if(!el) return;
    if(!text){ show(el,false); el.textContent=""; return; } el.textContent=text; show(el,true); }
  function setOk(id,text){ var el=$(id); if(!el) return;
    if(!text){ show(el,false); el.textContent=""; return; } el.textContent=text; show(el,true); }
  function lock(on){
    ["btnArt","btnBuild","btnRefine","btnPub","btnUndo","btnOtp","btnVerify"].forEach(function(id){
      var el=$(id); if(el) el.disabled=on; });
  }

  async function api(path,body){
    var res = await fetch(path, {
      method: body===undefined ? "GET" : "POST",
      headers: body===undefined ? {} : {"content-type":"application/json"},
      body: body===undefined ? undefined : JSON.stringify(body)
    });
    var text = await res.text(), data = null;
    try { data = JSON.parse(text); } catch(e) { data = null; }
    if (!res.ok || !data) {
      var shown = data && data.error ? data.error
        : "HTTP " + res.status + " : " + String(text).replace(/<[^>]*>/g," ").replace(/\\s+/g," ").trim().slice(0,180);
      var err = new Error(shown); err.status = res.status; throw err;
    }
    return data;
  }

  /* ---------------- views ---------------- */
  function goView(v){
    state.view = v;
    ["build","sites","admin"].forEach(function(k){ show($("view-"+k), k===v); });
    Array.prototype.forEach.call($("nav").children, function(b){
      b.classList.toggle("on", b.getAttribute("data-view")===v);
    });
    if (v==="admin") loadAdmin();
    window.scrollTo({top:0,behavior:"smooth"});
  }

  /* ---------------- auth ---------------- */
  async function askOtp(){
    setErr("loginErr","");
    var email = $("email").value.trim().toLowerCase();
    if(!email){ setErr("loginErr","Enter your email first."); return; }
    lock(true);
    try{
      await api("/api/otp",{email:email});
      show($("otpStep"),true); $("code").focus(); $("btnOtp").textContent="Code sent";
    }catch(e){ setErr("loginErr",e.message); }
    finally{ lock(false); }
  }

  async function verify(){
    setErr("loginErr","");
    var email = $("email").value.trim().toLowerCase();
    var code = $("code").value.replace(/\\D/g,"");
    if(code.length!==6){ setErr("loginErr","Enter the 6-digit code."); return; }
    lock(true);
    try{ await api("/api/verify",{email:email,code:code}); await boot(); }
    catch(e){ setErr("loginErr",e.message); }
    finally{ lock(false); }
  }

  async function doLogout(){
    if(!confirm("Log out?")) return;
    try{ await api("/api/logout",{}); }catch(e){}
    location.reload();
  }

  /* ---------------- boot ---------------- */
  async function boot(){
    var data;
    try{ data = await api("/api/me"); }
    catch(e){ show($("login"),true); show($("app"),false); show($("userBox"),false); return; }

    state.user = data.email;
    state.usage = data.usage;
    state.sites = data.sites || [];
    $("avatar").textContent = (data.email||"?").charAt(0);
    show($("userBox"),true); show($("login"),false); show($("app"),true);
    paintUsage(); paintSites();

    try{
      var a = await api("/api/admin");
      state.isAdmin = true; show($("navAdmin"),true); paintAdmin(a);
    }catch(e){ state.isAdmin = false; show($("navAdmin"),false); }
  }

  function paintUsage(){
    var u = state.usage; if(!u) return;
    var left = u.ops.cap - u.ops.used;
    $("chips").innerHTML =
      '<div class="chip">Today: <b>' + u.ops.used + "/" + u.ops.cap + " operations</b></div>" +
      '<div class="chip">Resets: <b>midnight IST</b></div>';
    $("pubHint").textContent = left>0
      ? left + " operation" + (left===1?"":"s") + " left today. New site = 1, edit = 1."
      : "All " + u.ops.cap + " operations used. Resets at midnight IST.";
    $("btnPub").disabled = left<=0;
  }

  function paintEdits(){
    $("editName").textContent = state.slug
      ? "/s/" + state.slug + (state.opsLeft===null ? "" : " · " + state.opsLeft + " left")
      : "";
  }

  function paintSites(){
    var ul = $("siteList");
    if(!state.sites.length){
      ul.innerHTML = '<li style="color:var(--faint);font-size:13px">Nothing yet.</li>'; return;
    }
    ul.innerHTML = state.sites.map(function(s){
      var when = (s.createdAt||"").slice(0,10);
      return '<li><a href="/s/' + s.slug + '/" target="_blank" rel="noopener">' + esc(s.name||s.slug) +
        "<small>/s/" + s.slug + " · " + when + "</small></a>" +
        '<button class="sm" data-slug="' + s.slug + '" onclick="openSite(this.dataset.slug)">Edit</button>' +
        '<button class="sm danger" data-slug="' + s.slug + '" onclick="delSite(this.dataset.slug)">Delete</button></li>';
    }).join("");
  }

  /* ---------------- stage 1 ---------------- */
  async function runArt(){
    setErr("artErr",""); setErr("buildErr","");
    var prompt = $("prompt").value.trim();
    if(prompt.length<10){ setErr("artErr","Describe the idea in a little more detail (at least 10 characters)."); return; }
    if(state.brief && !confirm("Create a new design direction? The current brief will be replaced and one AI call will be used.")) return;

    state.prompt = prompt;
    lock(true); setStatus(1,"Thinking through the design direction...",true);
    try{
      var data = await api("/api/art",{prompt:prompt});
      state.brief = data.brief; state.usage = data.usage;
      paintUsage(); paintBrief(data.brief);
      show($("briefCard"),true); show($("previewCard"),false);
      setStatus(1,"Design direction is ready. Read it below, then approve.");
    }catch(e){ setErr("artErr",e.message); setStatus(1,""); }
    finally{ lock(false); }
  }

  function kv(k,v){ return '<div class="kv"><span>' + esc(k) + "</span><div>" + esc(v) + "</div></div>"; }

  function paintBrief(b){
    var p=b.palette||{}, t=b.typography||{}, rows="";
    if(b.concept) rows += kv("Concept",b.concept);
    if(b.audience) rows += kv("Audience",b.audience);
    if(b.tone) rows += kv("Tone",b.tone);
    if(b.layout) rows += kv("Layout",b.layout);
    if(t.display) rows += kv("Fonts", t.display + " + " + (t.body||""));
    if(b.avoid) rows += kv("Avoid",b.avoid);

    var sw="";
    ["bg","surface","ink","muted","accent"].forEach(function(k){
      if(p[k]) sw += '<div class="sw" title="' + k + " " + p[k] + '" style="background:' + p[k] + '"></div>';
    });

    var pageRow = (b.pages && b.pages.length)
      ? kv("Pages", b.pages.map(function(x){ return x.title || x.path; }).join(" · ")) : "";

    var secs = (b.sections||[]).map(function(s){
      return "<li><b>" + esc(s.name||"") + "</b><em>" + esc(s.purpose||"") +
        (s.content ? " — " + esc(s.content) : "") + "</em></li>";
    }).join("");

    var hero="";
    if(b.heroLine) hero += kv("Headline",b.heroLine);
    if(b.subLine) hero += kv("Subline",b.subLine);
    if(b.cta) hero += kv("Button",b.cta);

    $("briefBody").innerHTML =
      (b.concept ? '<p style="font-size:14px;color:var(--dim);margin:0 0 12px">' + esc(b.concept) + "</p>" : "") +
      '<div class="swatches">' + sw + "</div>" + hero + pageRow + rows +
      (secs ? '<ul class="sections">' + secs + "</ul>" : "");
  }

  /* ---------------- stage 2 ---------------- */
  async function runBuild(){
    if(!state.brief){ setErr("buildErr","Create a design direction first."); return; }
    if(!confirm("Build the full site? One AI call will be used.")) return;
    setErr("buildErr","");
    lock(true); setStatus(2,"Writing the pages...",true);
    try{
      var data = await api("/api/build",{prompt:state.prompt,brief:state.brief});
      state.pages = data.pages||[]; state.active=0; state.undo=[];
      state.usage = data.usage;
      if(typeof data.editsLeft==="number") state.opsLeft = data.editsLeft;
      paintUsage(); paintEdits();
      showPreview(state.pages); show($("previewCard"),true); show($("linkBox"),false);
      setStatus(2, state.pages.length + " page" + (state.pages.length===1?"":"s") + " built. Review the tabs, then refine or publish.");
    }catch(e){ setErr("buildErr",e.message); setStatus(2,""); }
    finally{ lock(false); }
  }

  async function runRefine(){
    if(!state.pages.length){ setStatus(2,"Build a site first."); return; }
    var instruction = $("tweak").value.trim();
    if(!instruction){ setErr("pubErr","Describe the change you want."); return; }
    if(state.opsLeft!==null && state.opsLeft<=0){
      setErr("pubErr","All operations for today are used. Resets at midnight IST."); return;
    }
    if(!confirm("Apply this change? One AI call and one operation will be used.")) return;
    setErr("pubErr","");
    lock(true); setStatus(2,"Applying the change...",true);
    try{
      var data = await api("/api/build",{prompt:state.prompt,brief:state.brief,pages:state.pages,instruction:instruction,slug:state.slug});
      state.undo.push(clonePages());
      state.pages = data.pages || state.pages;
      state.usage = data.usage;
      if(typeof data.editsLeft==="number") state.opsLeft = data.editsLeft;
      paintUsage(); paintEdits(); showPreview(state.pages);
      $("tweak").value="";
      setStatus(2,"Updated." + (state.opsLeft===null?"":" "+state.opsLeft+" operations left today."));
    }catch(e){ setErr("pubErr",e.message); setStatus(2,""); }
    finally{ lock(false); }
  }

  /* ---------------- preview ---------------- */
  function paintTabs(){
    var box = $("pageTabs");
    if(!state.pages.length){ show(box,false); box.innerHTML=""; return; }
    box.innerHTML = state.pages.map(function(p,i){
      return '<button class="tab' + (i===state.active?" on":"") + '" data-i="' + i +
        '" onclick="switchPage(this.dataset.i)">' + esc(p.title||p.path) + "</button>";
    }).join("");
    show(box,true);
  }

  function switchPage(i){ state.active = Number(i)||0; paintTabs(); renderFrame(); }

  function renderFrame(){
    var f = $("frame"), empty = $("empty");
    var p = state.pages[state.active];
    if(!p){ f.srcdoc=""; show(f,false); show(empty,true); return; }
    show(empty,false); show(f,true);
    f.style.width = state.device ? Math.min(state.device, 100000) + "px" : "100%";
    f.srcdoc = p.html;
  }

  function setDevice(w,btn){
    state.device = w;
    Array.prototype.forEach.call($("devSeg").children,function(b){ b.classList.toggle("on", b===btn); });
    renderFrame();
  }

  function openInTab(){
    var p = state.pages[state.active];
    if(!p){ alert("Nothing to open yet."); return; }
    var blob = new Blob([p.html], {type:"text/html"});
    var url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(function(){ URL.revokeObjectURL(url); }, 60000);
  }

  function showPreview(pages){
    state.pages = pages||[];
    if(state.active>=state.pages.length) state.active=0;
    paintTabs(); renderFrame();
  }

  /* ---------------- publish ---------------- */
  async function runPublish(){
    if(!state.pages.length) return;
    if(state.slug){ await updateCurrent(); return; }
    var left = state.usage ? state.usage.ops.cap - state.usage.ops.used : 0;
    if(left<=0){ setErr("pubErr","Your publish quota for today is used."); return; }
    var name = prompt("Site name? (used in the link)", "kovik-site");
    if(name===null) return;
    if(!confirm("Publish? " + state.pages.length + " page(s) will go live and this costs 1 operation (" + left + " left).")) return;

    setErr("pubErr","");
    lock(true); setStatus(2,"Publishing...",true);
    try{
      var data = await api("/api/publish",{pages:state.pages,brief:state.brief,name:name,prompt:state.prompt});
      state.usage = data.usage; state.slug = data.slug;
      state.opsLeft = data.editsLeft===undefined ? null : data.editsLeft;
      paintUsage(); paintEdits();
      show($("editBar"),true); $("btnPub").textContent="Update site";
      $("linkBox").innerHTML = 'Live: <a href="' + data.url + '" target="_blank" rel="noopener">' + data.url + "</a>";
      show($("linkBox"),true);
      setStatus(2,"Published.");
      var me2 = await api("/api/me"); state.sites = me2.sites||[]; paintSites();
    }catch(e){ setErr("pubErr",e.message); setStatus(2,""); }
    finally{ lock(false); }
  }

  async function updateCurrent(){
    if(!confirm("Update this site? The previous version is saved and can be restored later.")) return;
    setErr("pubErr","");
    lock(true); setStatus(2,"Updating...",true);
    try{
      var d = await api("/api/update",{slug:state.slug,pages:state.pages,brief:state.brief});
      paintVersions(d.versions||[]);
      $("linkBox").innerHTML = 'Live: <a href="' + d.url + '" target="_blank" rel="noopener">' + d.url + "</a>";
      show($("linkBox"),true);
      setStatus(2,"Updated. This does not use a publish credit.");
      var me2 = await api("/api/me"); state.sites = me2.sites||[]; paintSites();
    }catch(e){ setErr("pubErr",e.message); setStatus(2,""); }
    finally{ lock(false); }
  }

  /* ---------------- existing site ---------------- */
  async function openSite(slug){
    try{
      var d = await api("/api/site/" + slug), site = d.site;
      state.slug = site.slug; state.prompt = site.prompt||""; state.brief = site.brief||null;
      state.pages = site.pages||[]; state.active=0; state.undo=[];
      state.opsLeft = typeof site.editsLeft==="number" ? site.editsLeft : null;
      $("prompt").value = state.prompt; $("tweak").value="";
      setErr("artErr",""); setErr("buildErr",""); setErr("pubErr","");
      if(state.brief){ paintBrief(state.brief); show($("briefCard"),true); }
      showPreview(state.pages); show($("previewCard"),true); show($("linkBox"),false);
      paintVersions(site.versions||[]);
      $("btnPub").textContent="Update site"; show($("editBar"),true); paintEdits();
      setStatus(2,"Editing this site. Make your changes, then press Update.");
      goView("build");
    }catch(e){ alert(e.message); }
  }

  function paintVersions(list){
    var box = $("versions");
    if(!list || !list.length){ show(box,false); box.innerHTML=""; return; }
    box.innerHTML = list.map(function(v,i){
      var t=(v.at||"").slice(11,16), d=(v.at||"").slice(5,10);
      return '<button class="sm" data-id="' + v.id + '" onclick="restoreVer(this.dataset.id)">v' +
        (list.length-i) + " · " + d + " " + t + "</button>";
    }).join("");
    show(box,true);
  }

  async function restoreVer(id){
    if(!confirm("Load this older version into the preview? The live site stays unchanged until you press Update.")) return;
    try{
      var d = await api("/api/restore",{slug:state.slug,id:id});
      state.undo.push(clonePages()); state.pages = d.pages||[]; state.active=0;
      showPreview(state.pages);
      setStatus(2,"Older version loaded. Press Update to make it live.");
    }catch(e){ alert(e.message); }
  }

  function undoEdit(){
    if(!state.undo.length){ setStatus(2,"Nothing to undo."); return; }
    state.pages = state.undo.pop(); state.active=0;
    showPreview(state.pages); setStatus(2,"Stepped back one version.");
  }

  function newSite(){
    if(!confirm("Start a new site? The current edit will be closed (the live site is unaffected).")) return;
    state.slug=null; state.pages=[]; state.brief=null; state.prompt=""; state.undo=[]; state.active=0; state.opsLeft=null;
    $("prompt").value=""; $("tweak").value="";
    show($("briefCard"),false); show($("previewCard"),false); show($("linkBox"),false); show($("editBar"),false);
    paintVersions([]); $("btnPub").textContent="Publish";
    setStatus(1,""); setStatus(2,"");
    setErr("artErr",""); setErr("buildErr",""); setErr("pubErr","");
    window.scrollTo({top:0,behavior:"smooth"});
  }

  async function delSite(slug){
    if(!confirm("Delete this site? The link will stop working.")) return;
    try{
      await api("/api/delete",{slug:slug});
      state.sites = state.sites.filter(function(s){ return s.slug!==slug; });
      if(state.slug===slug) newSite();
      paintSites();
    }catch(e){ alert(e.message); }
  }

  /* ---------------- admin ---------------- */
  function badge(id, val, isSet){
    var el = $(id); if(!el) return;
    el.textContent = isSet ? (val ? val : "set") : "not set";
    el.className = "badge " + (isSet ? "set" : "unset");
  }

  function paintAdmin(a){
    state.isAdmin = true;
    badge("badgeAi", a.config.aiKey, !!a.config.aiKey);
    badge("badgeUser", a.config.gmailUser, !!a.config.gmailUser);
    badge("badgePass", a.config.gmailPass, !!a.config.gmailPass);
    $("sBuild").textContent = a.build || "—";
    $("sEngine").textContent = a.engine || "—";
    $("sKv").textContent = a.kvOk ? "connected" : "not bound";
    $("sPanel").textContent = a.fromPanel ? "yes" : "no (using dashboard)";
    $("aMailUser").placeholder = a.config.gmailUser || "you@gmail.com";
    $("aDaily").placeholder = a.config.dailyLimit;
    $("aPages").placeholder = a.config.maxPages;
    $("adminStatus").innerHTML =
      '<div class="stat"><span>Storage</span><b>' + (a.kvOk ? "connected" : "not bound") + "</b></div>" +
      '<div class="stat"><span>AI key</span><b>' + (a.config.aiKey ? "saved" : "missing") + "</b></div>" +
      '<div class="stat"><span>Email</span><b>' + (a.config.gmailUser && a.config.gmailPass ? "ready" : "incomplete") + "</b></div>";
  }

  async function loadAdmin(){
    if(!state.isAdmin){ show($("view-admin"),false); goView("build"); return; }
    try{ paintAdmin(await api("/api/admin")); }catch(e){ setErr("aiErr",e.message); }
  }

  async function saveAdmin(){
    setErr("aiErr",""); setErr("mailErr",""); setOk("aiOk",""); setOk("mailOk","");
    var body = {};
    var g = $("aAiKey").value.trim(); if(g) body.aiKey = g;
    var u = $("aMailUser").value.trim(); if(u) body.gmailUser = u;
    var p = $("aMailPass").value.trim(); if(p) body.gmailPass = p;
    var d = $("aDaily").value.trim(); if(d) body.dailyLimit = d;
    var pg = $("aPages").value.trim(); if(pg) body.maxPages = pg;
    if(!Object.keys(body).length){ setErr("aiErr","Nothing to save — fill at least one field."); return; }
    try{
      await api("/api/admin/save", body);
      $("aAiKey").value=""; $("aMailPass").value="";
      setOk("aiOk","Saved. Keys are stored on the server and are never shown again.");
      paintAdmin(await api("/api/admin"));
    }catch(e){ setErr("aiErr",e.message); }
  }

  async function testAi(){
    setErr("aiErr",""); setOk("aiOk","Testing…");
    try{
      var d = await api("/api/admin/test-ai",{});
      if(d.ok) setOk("aiOk","AI replied: " + d.reply);
      else { setOk("aiOk",""); setErr("aiErr", d.error || "AI test failed."); }
    }catch(e){ setOk("aiOk",""); setErr("aiErr",e.message); }
  }

  async function testMail(){
    setErr("mailErr",""); setOk("mailOk","Sending…");
    try{
      var d = await api("/api/admin/test-mail",{});
      if(d.ok) setOk("mailOk","Test email sent to " + d.to);
      else { setOk("mailOk",""); setErr("mailErr", d.error || "Email test failed."); }
    }catch(e){ setOk("mailOk",""); setErr("mailErr",e.message); }
  }

  boot();
</script>
</body>
</html>
`;

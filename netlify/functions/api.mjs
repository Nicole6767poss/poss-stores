// PossAbilities Stores – single API function
// Env vars (Netlify → Site configuration → Environment variables):
//   STORES_USERNAME  shared username
//   STORES_PASSWORD  shared password
//   STORES_SECRET    long random string used to sign login tokens
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const config = { path: "/api/*" };

const TOKEN_DAYS = 30;
const EMPTY = () => ({ version: 0, items: [], moves: [], suppliers: [], lists: { recipients: [], staff: [] } });

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const store = () => getStore({ name: "possabilities-stores", consistency: "strong" });

// ---------- auth ----------
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const env = (k) => process.env[k] || "";
// Changing the username or password invalidates every existing login.
const credVersion = () => sha(env("STORES_USERNAME") + "\u0000" + env("STORES_PASSWORD")).toString("base64url").slice(0, 12);

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", env("STORES_SECRET")).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verify(token) {
  if (!token || !env("STORES_SECRET")) return false;
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  const expected = crypto.createHmac("sha256", env("STORES_SECRET")).update(body).digest("base64url");
  if (!same(sig, expected)) return false;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() && p.cv === credVersion();
  } catch { return false; }
}
function tokenFrom(req, url) {
  const h = req.headers.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return url.searchParams.get("t") || "";
}

// ---------- data ----------
async function load() {
  const r = await store().getWithMetadata("db", { type: "json" });
  return r ? { data: r.data, etag: r.etag } : { data: EMPTY(), etag: null };
}
// Read–modify–write with a conditional write, so two people saving at once never overwrite each other.
async function mutate(fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, etag } = await load();
    const result = await fn(data);
    data.version = (data.version || 0) + 1;
    data.updatedAt = Date.now();
    const res = await store().setJSON("db", data, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (!res || res.modified !== false) return { data, result };
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 200));
  }
  throw new HttpError(409, "Too many changes at once. Try again.");
}

const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const whole = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : NaN; };
const newId = () => crypto.randomBytes(9).toString("base64url");
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const validId = (s) => /^[A-Za-z0-9_-]{6,40}$/.test(s || "");

// Sizes: [{size:"M", quantity:5}, …] in the order the user entered them. null = item has no sizes.
function cleanSizes(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const seen = new Set(), out = [];
  for (const x of list.slice(0, 40)) {
    const size = str(x?.size, 20);
    if (!size || seen.has(size.toLowerCase())) continue;
    const q = whole(x.quantity);
    if (Number.isNaN(q)) throw new HttpError(400, `Quantity for size ${size} must be a whole number, 0 or more.`);
    seen.add(size.toLowerCase()); out.push({ size, quantity: q });
  }
  return out.length ? out : null;
}
const total = (it) => it.sizes.reduce((t, x) => t + x.quantity, 0);
const findSize = (it, size) => it.sizes?.find((x) => x.size.toLowerCase() === String(size || "").trim().toLowerCase());

function cleanItem(b) {
  const name = str(b.name, 120);
  if (!name) throw new HttpError(400, "Give the item a name.");
  const sizes = cleanSizes(b.sizes);
  const quantity = sizes ? sizes.reduce((t, x) => t + x.quantity, 0) : whole(b.quantity), minLevel = b.minLevel === "" || b.minLevel == null ? 0 : whole(b.minLevel);
  if (Number.isNaN(quantity)) throw new HttpError(400, "Quantity must be a whole number, 0 or more.");
  if (Number.isNaN(minLevel)) throw new HttpError(400, "Low-stock level must be a whole number, 0 or more.");
  return {
    name, quantity, minLevel,
    category: str(b.category, 60), location: str(b.location, 60), unit: str(b.unit, 30),
    notes: str(b.notes, 600), supplierId: str(b.supplierId, 40), sizes,
    photo: b.photo && validId(b.photo) ? b.photo : null,
  };
}
function cleanSupplier(b) {
  const name = str(b.name, 120);
  if (!name) throw new HttpError(400, "Give the supplier a name.");
  return {
    name, contact: str(b.contact, 100), phone: str(b.phone, 40), phone2: str(b.phone2, 40),
    email: str(b.email, 120), website: str(b.website, 200), address: str(b.address, 300),
    accountRef: str(b.accountRef, 60), supplies: str(b.supplies, 300), notes: str(b.notes, 800),
  };
}
const status = (it) => {
  if (it.sizes?.length) {
    if (it.sizes.every((x) => x.quantity <= 0)) return "out";
    return it.sizes.some((x) => x.quantity <= (it.minLevel || 0)) ? "low" : "ok";
  }
  return it.quantity <= 0 ? "out" : it.quantity <= (it.minLevel || 0) ? "low" : "ok";
};

async function deletePhoto(id) { if (id) { try { await store().delete("photo/" + id); } catch {} } }

// ---------- handler ----------
export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const [resource, id] = parts;
  const method = req.method;

  try {
    // Login
    if (resource === "login" && method === "POST") {
      if (!env("STORES_USERNAME") || !env("STORES_PASSWORD") || !env("STORES_SECRET"))
        throw new HttpError(500, "The site's login isn't set up yet. Add the environment variables in Netlify.");
      const b = await req.json().catch(() => ({}));
      const okUser = same(str(b.username, 200).toLowerCase(), env("STORES_USERNAME").toLowerCase());
      const okPass = same(String(b.password ?? ""), env("STORES_PASSWORD"));
      if (!(okUser && okPass)) {
        await new Promise((r) => setTimeout(r, 900));
        throw new HttpError(401, "Username or password is incorrect.");
      }
      return json({ token: sign({ exp: Date.now() + TOKEN_DAYS * 864e5, cv: credVersion() }) });
    }

    if (!verify(tokenFrom(req, url))) return json({ error: "Please log in again." }, 401);

    // Photos
    if (resource === "photos") {
      if (method === "POST") {
        const type = (req.headers.get("content-type") || "").split(";")[0];
        if (!["image/jpeg", "image/png", "image/webp"].includes(type)) throw new HttpError(400, "Use a JPG or PNG photo.");
        const buf = await req.arrayBuffer();
        if (!buf.byteLength) throw new HttpError(400, "The photo was empty.");
        if (buf.byteLength > 4 * 1024 * 1024) throw new HttpError(413, "That photo is too large.");
        const pid = newId();
        await store().set("photo/" + pid, buf, { metadata: { type } });
        return json({ id: pid });
      }
      if (method === "GET" && validId(id)) {
        const r = await store().getWithMetadata("photo/" + id, { type: "arrayBuffer" });
        if (!r) return new Response("Not found", { status: 404 });
        return new Response(r.data, { headers: { "content-type": r.metadata?.type || "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
      }
    }

    // Full state (polled for live updates)
    if (resource === "state" && method === "GET") {
      const { data } = await load();
      const v = Number(url.searchParams.get("v"));
      if (v && v === data.version) return json({ unchanged: true, version: data.version });
      return json(data);
    }

    // Items
    if (resource === "items") {
      if (method === "POST") {
        const b = await req.json();
        let oldPhoto = null;
        const { data } = await mutate((d) => {
          const clean = cleanItem(b);
          if (b.id) {
            const it = d.items.find((x) => x.id === b.id);
            if (!it) throw new HttpError(404, "That item no longer exists.");
            oldPhoto = it.photo && it.photo !== clean.photo ? it.photo : null;
            Object.assign(it, clean, { updatedAt: Date.now() });
          } else {
            d.items.push({ id: newId(), ...clean, createdAt: Date.now(), updatedAt: Date.now() });
          }
        });
        await deletePhoto(oldPhoto);
        return json(data);
      }
      if (method === "DELETE" && id) {
        let photo = null;
        const { data } = await mutate((d) => {
          const it = d.items.find((x) => x.id === id);
          photo = it?.photo || null;
          d.items = d.items.filter((x) => x.id !== id);
        });
        await deletePhoto(photo);
        return json(data);
      }
    }

    // Stock movements (issues and deliveries)
    if (resource === "moves") {
      if (method === "POST") {
        const b = await req.json();
        const { data, result } = await mutate((d) => {
          const it = d.items.find((x) => x.id === b.itemId);
          if (!it) throw new HttpError(404, "That item no longer exists.");
          const type = b.type === "received" ? "received" : "issued";
          const qty = whole(b.qty);
          if (!(qty >= 1)) throw new HttpError(400, "Enter a quantity of at least 1.");
          let sz = null;
          if (it.sizes?.length) {
            sz = findSize(it, b.size);
            if (!sz) throw new HttpError(400, "Choose a size.");
          }
          const avail = sz ? sz.quantity : it.quantity;
          if (type === "issued" && qty > avail)
            throw new HttpError(400, `Only ${avail} in stock${sz ? ` in size ${sz.size}` : ""}. Issue ${avail} or fewer.`);
          const person = str(b.person, 100);
          if (type === "issued" && !person) throw new HttpError(400, "Say who the items were issued to.");
          const date = isDate(b.date) ? b.date : new Date().toISOString().slice(0, 10);
          const delta = type === "issued" ? -qty : qty;
          if (sz) { sz.quantity += delta; it.quantity = total(it); } else it.quantity += delta;
          it.updatedAt = Date.now();
          d.moves.push({
            id: newId(), type, itemId: it.id, itemName: it.name, size: sz ? sz.size : "", unit: it.unit || "", qty, person,
            purpose: type === "issued" ? str(b.purpose, 160) : "", by: str(b.by, 80), date,
            notes: str(b.notes, 400), createdAt: Date.now(),
          });
          return { status: status(it), quantity: sz ? sz.quantity : it.quantity, size: sz ? sz.size : "" };
        });
        return json({ ...data, result });
      }
      if (method === "DELETE" && id) {
        const restock = url.searchParams.get("restock") === "1";
        const { data } = await mutate((d) => {
          const m = d.moves.find((x) => x.id === id);
          if (!m) return;
          if (restock) {
            const it = d.items.find((x) => x.id === m.itemId);
            if (it) {
              const delta = m.type === "issued" ? m.qty : -m.qty;
              if (m.size && it.sizes?.length) {
                let sz = findSize(it, m.size);
                if (!sz) { sz = { size: m.size, quantity: 0 }; it.sizes.push(sz); }
                sz.quantity = Math.max(0, sz.quantity + delta);
                it.quantity = total(it);
              } else it.quantity = Math.max(0, it.quantity + delta);
            }
          }
          d.moves = d.moves.filter((x) => x.id !== id);
        });
        return json(data);
      }
    }

    // Preset name lists (drop-downs for "Issued to" and "Recorded by")
    if (resource === "lists" && method === "POST") {
      const b = await req.json();
      if (!["recipients", "staff"].includes(b.list)) throw new HttpError(400, "Unknown list.");
      const tidy = (arr) => [...new Map(arr.map((n) => str(n, 100)).filter(Boolean).map((n) => [n.toLowerCase(), n])).values()]
        .sort((a, c) => a.localeCompare(c)).slice(0, 500);
      const { data } = await mutate((d) => {
        d.lists ||= { recipients: [], staff: [] };
        let arr = d.lists[b.list] || [];
        if (Array.isArray(b.add)) arr = arr.concat(b.add);
        if (b.remove) arr = arr.filter((n) => n.toLowerCase() !== String(b.remove).toLowerCase());
        d.lists[b.list] = tidy(arr);
      });
      return json(data);
    }

    // Suppliers
    if (resource === "suppliers") {
      if (method === "POST") {
        const b = await req.json();
        const { data } = await mutate((d) => {
          d.suppliers ||= [];
          const clean = cleanSupplier(b);
          if (b.id) {
            const s = d.suppliers.find((x) => x.id === b.id);
            if (!s) throw new HttpError(404, "That supplier no longer exists.");
            Object.assign(s, clean, { updatedAt: Date.now() });
          } else d.suppliers.push({ id: newId(), ...clean, createdAt: Date.now(), updatedAt: Date.now() });
        });
        return json(data);
      }
      if (method === "DELETE" && id) {
        const { data } = await mutate((d) => {
          d.suppliers = (d.suppliers || []).filter((x) => x.id !== id);
          d.items.forEach((it) => { if (it.supplierId === id) it.supplierId = ""; });
        });
        return json(data);
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Something went wrong on the server. Try again." }, 500);
  }
};

// Plain-HTTP client for Picnic's private mobile API. Unofficial; see ENDPOINTS.md.
export interface Env {
  STATE: KVNamespace;
  PICNIC_EMAIL: string;
  PICNIC_PASSWORD: string;
  PICNIC_COUNTRY?: string;
  PUBLIC_HOST?: string;
  STATE_KEY: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ALLOWED_EMAIL: string;
}

import { imageUrl, parseRecipe, recipeTiles, ImageSize } from "./meals";

const API_VERSION = "15";
const CLIENT_ID = 30100;
const USER_AGENT = "okhttp/4.9.0";
const PICNIC_AGENT = "30100;1.15.183-14941;";
const SESSION_KEY = "session";

export class PicnicError extends Error {}
export class Picnic2FARequired extends PicnicError {
  constructor() {
    super("Picnic needs a 2FA code. Call generate_2fa_code, then verify_2fa_code with the code you receive.");
  }
}

const money = (c: unknown): number | null => (c == null || isNaN(Number(c)) ? null : Math.round(Number(c)) / 100);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(env: Env, usage: KeyUsage[]) {
  return crypto.subtle.importKey("raw", unb64(env.STATE_KEY), "AES-GCM", false, usage);
}
async function seal(env: Env, data: object): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env, ["encrypt"]), new TextEncoder().encode(JSON.stringify(data))));
  return b64(iv) + "." + b64(ct);
}
async function open<T>(env: Env, s: string): Promise<T | null> {
  try {
    const [iv, ct] = s.split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(env, ["decrypt"]), unb64(ct));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return null;
  }
}

interface Session { token: string; deviceId: string }

function* sellingUnits(node: any): Generator<any> {
  if (Array.isArray(node)) for (const n of node) yield* sellingUnits(n);
  else if (node && typeof node === "object") {
    const su = node.sellingUnit;
    if (su && typeof su === "object" && "id" in su && "name" in su) yield su;
    for (const v of Object.values(node)) if (v && typeof v === "object") yield* sellingUnits(v);
  }
}

export class PicnicClient {
  private session: Session | null = null;
  private base: string;
  readonly origin: string;
  constructor(private env: Env) {
    this.origin = `https://storefront-prod.${(env.PICNIC_COUNTRY || "DE").toLowerCase()}.picnicinternational.com`;
    this.base = `${this.origin}/api/${API_VERSION}`;
  }

  private async load() {
    if (this.session) return;
    const raw = await this.env.STATE.get(SESSION_KEY);
    this.session = (raw && (await open<Session>(this.env, raw))) || { token: "", deviceId: hex(crypto.getRandomValues(new Uint8Array(8)).buffer).toUpperCase() };
  }
  private async save() {
    // Picnic session tokens are long-lived; expire the cached copy after 30 days regardless.
    await this.env.STATE.put(SESSION_KEY, await seal(this.env, this.session!), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  private async http(method: string, path: string, body?: unknown, retried = false): Promise<Response> {
    await this.load();
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json; charset=UTF-8",
      "x-picnic-agent": PICNIC_AGENT,
      "x-picnic-did": this.session!.deviceId,
    };
    if (this.session!.token) headers["x-picnic-auth"] = this.session!.token;
    let res: Response;
    try {
      res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      if (!retried) return this.http(method, path, body, true);
      throw new PicnicError("Could not reach Picnic.");
    }
    if (res.status === 429) throw new PicnicError("Picnic is rate-limiting (429). Wait before retrying.");
    if (res.status >= 500 && !retried) return this.http(method, path, body, true);
    const tok = res.headers.get("x-picnic-auth");
    if (tok && tok !== this.session!.token) {
      this.session!.token = tok;
      await this.save();
    }
    return res;
  }

  async login(): Promise<void> {
    const secret = hex(await crypto.subtle.digest("MD5", new TextEncoder().encode(this.env.PICNIC_PASSWORD)));
    await this.load();
    this.session!.token = "";
    const res = await this.http("POST", "/user/login", { key: this.env.PICNIC_EMAIL, secret, client_id: CLIENT_ID });
    if (res.status === 401) throw new PicnicError("Picnic rejected the email/password.");
    if (!res.ok) {
      const e: any = await res.json().catch(() => null);
      throw new PicnicError(`Picnic login failed (HTTP ${res.status}${e?.error?.code ? ", " + e.error.code : ""}).`);
    }
    const data: any = await res.json().catch(() => null);
    if (data?.second_factor_authentication_required) throw new Picnic2FARequired();
  }

  // Authenticated call with one automatic re-login when the session has expired.
  private async call(method: string, path: string, body?: unknown): Promise<any> {
    await this.load();
    if (!this.session!.token) await this.login();
    let res = await this.http(method, path, body);
    if (res.status === 401) {
      await this.login();
      res = await this.http(method, path, body);
    }
    if (res.status === 403) throw new Picnic2FARequired();
    if (!res.ok) throw new PicnicError(`Picnic returned HTTP ${res.status} for ${path}.`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async generate2fa(channel = "SMS") {
    await this.load();
    if (!this.session!.token) await this.login().catch((e) => { if (!(e instanceof Picnic2FARequired)) throw e; });
    await this.call2fa("/user/2fa/generate", { channel });
  }
  async verify2fa(code: string) {
    await this.load();
    if (!this.session!.token) await this.login().catch((e) => { if (!(e instanceof Picnic2FARequired)) throw e; });
    await this.call2fa("/user/2fa/verify", { otp: code });
  }
  private async call2fa(path: string, body: unknown) {
    const res = await this.http("POST", path, body);
    if (!res.ok) throw new PicnicError(`Picnic rejected the 2FA request (HTTP ${res.status}).`);
  }

  async searchRecipes(query: string, limit = 20) {
    const raw = await this.call("GET", `/pages/search-page-results?search_term=${encodeURIComponent(query)}&page_context=MEALS&is_recipe=true`);
    return recipeTiles(raw, this.origin).slice(0, limit);
  }
  async listRecipes(section: "cookbook" | "weekly_suggestions" | "ordered", limit = 40) {
    const page = { cookbook: "cookbook-page-content", weekly_suggestions: "meals-planner-root", ordered: "meals-purchase-page-root" }[section];
    const raw = await this.call("GET", `/pages/${page}`);
    return recipeTiles(raw, this.origin).slice(0, limit);
  }
  async getRecipe(id: string) {
    if (!/^[0-9a-f]{24}$/.test(id)) throw new PicnicError("recipe_id must be a 24-character id from search_recipes/list_recipes.");
    const raw = await this.call("GET", `/pages/selling-group-details-page?selling_group_id=${id}`);
    return parseRecipe(raw, id, this.origin);
  }
  async fetchImage(id: string, size: ImageSize) {
    const url = imageUrl(this.origin, id, size);
    if (!url) throw new PicnicError("Invalid image id.");
    const res = await fetch(url);
    if (!res.ok) throw new PicnicError(`Image not available (HTTP ${res.status}).`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 1_500_000) throw new PicnicError("Image too large; use a smaller size.");
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async searchProducts(query: string) {
    const raw = await this.call("GET", `/pages/search-page-results?search_term=${encodeURIComponent(query)}`);
    const seen = new Set<string>();
    const out: object[] = [];
    for (const p of sellingUnits(raw ?? {})) {
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, name: p.name, price: money(p.display_price ?? p.price), currency: "EUR", unit: p.unit_quantity, image_id: p.image_id ?? null, image_url: imageUrl(this.origin, p.image_id, "medium") });
    }
    return out;
  }

  async getCart() {
    const raw = (await this.call("GET", "/cart")) ?? {};
    const items: object[] = [];
    for (const line of raw.items ?? []) {
      if (line.type !== "ORDER_LINE" || !line.items?.length) continue;
      const a = line.items[0];
      const imgId = a.image_ids?.[0] ?? a.image_id ?? null;
      const item: any = { product_id: a.id, name: a.name, unit: a.unit_quantity, quantity: line.items.length, currency: "EUR", image_id: imgId, image_url: imageUrl(this.origin, imgId, "small") };
      const un = (a.decorators ?? []).find((d: any) => d.type === "UNAVAILABLE");
      if (un) {
        // Out-of-stock articles carry a 99999-cent placeholder price; trust the line price instead.
        item.available = false;
        item.unavailable_reason = un.explanation?.short_explanation ?? un.reason;
        item.unit_price = null;
        item.line_total = money(line.price);
        const rep = (un.replacements ?? []).map((r: any) => r.id).filter(Boolean);
        if (rep.length) item.suggested_replacement_ids = rep;
      } else {
        item.available = true;
        item.unit_price = money(a.price);
        item.line_total = money(line.price);
      }
      items.push(item);
    }
    return { items, total_count: raw.total_count, cart_total: money(raw.total_price), currency: "EUR" };
  }

  async addToCart(id: string, count: number) { await this.call("POST", "/cart/add_product", { product_id: id, count }); return this.getCart(); }
  async removeFromCart(id: string, count: number) { await this.call("POST", "/cart/remove_product", { product_id: id, count }); return this.getCart(); }
  async clearCart() { await this.call("POST", "/cart/clear"); return this.getCart(); }

  async getDeliverySlots() {
    const raw = (await this.call("GET", "/cart/delivery_slots")) ?? {};
    const sel = raw.selected_slot?.slot_id;
    return (raw.delivery_slots ?? []).map((s: any) => ({
      slot_id: s.slot_id, window_start: s.window_start, window_end: s.window_end, cut_off_time: s.cut_off_time,
      is_available: s.is_available, minimum_order_value: money(s.minimum_order_value),
      suggested: !!s.selected || (sel != null && s.slot_id === sel),
    }));
  }
  async setDeliverySlot(slotId: string) { await this.call("POST", "/cart/set_delivery_slot", { slot_id: slotId }); }
}

// Parsers for Picnic's server-driven ("PML") meals pages. Best-effort: Picnic can change these trees at any time.

export type ImageSize = "tiny" | "small" | "medium" | "large" | "extra-large";

export function imageUrl(base: string, id: string | null | undefined, size: ImageSize = "medium"): string | null {
  if (!id || !/^(recipes\/)?[0-9a-f]{32,128}$/.test(id)) return null;
  const path = id.startsWith("recipes/") ? id : id;
  return `${base}/static/images/${path}/${size}.png`;
}

const strip = (s: string) => s.replace(/#\(#[0-9a-fA-F]{6}\)/g, "").trim();

function* walk(n: any): Generator<any> {
  if (Array.isArray(n)) for (const x of n) yield* walk(x);
  else if (n && typeof n === "object") {
    yield n;
    for (const v of Object.values(n)) if (v && typeof v === "object") yield* walk(v);
  }
}

function texts(node: any): string[] {
  const out: string[] = [];
  for (const n of walk(node)) if (typeof n.markdown === "string" && n.markdown.trim()) out.push(strip(n.markdown));
  return out;
}
const dedupe = (a: string[]) => a.filter((x, i) => a.indexOf(x) === i);

function firstImage(node: any): string | null {
  for (const n of walk(node)) {
    if (n.type === "IMAGE" && typeof n.source?.id === "string") return n.source.id;
  }
  return null;
}

const BADGES = /^(Hinzufügen|Nicht alles vorrätig|In Bestellung|Vegan|Vegetarisch|Ohne Fleisch & Fisch|Neu|Beliebt)$/i;

export interface RecipeTile { recipe_id: string; title: string; image_id: string | null }

export function recipeTiles(page: any, base: string, size: ImageSize = "small") {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const n of walk(page)) {
    const target = n.onPress?.target;
    const m = typeof target === "string" && target.match(/selling_group_id=([0-9a-f]{24})/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    let label: string | null = null;
    for (const d of walk(n)) if (typeof d.accessibilityLabel === "string" && d.accessibilityLabel.trim()) { label = d.accessibilityLabel; break; }
    if (!label) {
      const t = dedupe(texts(n)).filter((x) => !BADGES.test(x));
      label = t.join(" | ") || null;
    }
    const img = firstImage(n);
    out.push({ recipe_id: m[1], title: label, image_id: img, image_url: imageUrl(base, img, size) });
  }
  return out;
}

export function parseRecipe(page: any, id: string, base: string) {
  const all = dedupe(texts(page));
  const at = (s: string) => all.indexOf(s);
  const title = all[0] ?? null;

  const timeIdx = all.findIndex((t) => /^\d+\s*min/i.test(t));
  const intro = timeIdx > 1 ? all.slice(1, timeIdx) : [];
  const time = timeIdx >= 0 ? all.slice(timeIdx, timeIdx + 2).join(" ") : null;

  // Hero image + portions come from the page's embedded state.
  let heroId: string | null = null;
  let portions: number | null = null;
  const ingState: Record<string, any> = {};
  for (const n of walk(page)) {
    const imgs = n.selling_group_image_data?.images?.images;
    if (!heroId && Array.isArray(imgs) && imgs.length) {
      const p = imgs.find((i: any) => i.primary) ?? imgs[0];
      heroId = (p.namespace ? `${p.namespace}/` : "") + p.id;
    }
    if (portions == null && typeof n.portions === "number") portions = n.portions;
    if (typeof n.ingredientId === "string" && n.sellingUnits && typeof n.sellingUnits === "object") ingState[n.ingredientId] = n;
  }

  // Product rows: analytics context carries the ingredient id; the row subtree carries the visible text.
  const products: any[] = [];
  for (const n of walk(page)) {
    const ctx = (n.analytics?.contexts ?? []).find((c: any) => String(c.schema).includes("analytics/product/"));
    if (!ctx) continue;
    const ingId: string = ctx.data.product_id;
    const t = dedupe(texts(n)).filter((x) => !/^(\d+|>|jetzt .*|-\d+%)$/.test(x));
    const st = ingState[ingId];
    const unitId = st ? Object.keys(st.sellingUnits)[0] : null;
    const su = unitId ? st.sellingUnits[unitId] : null;
    const need = t.find((x) => /benötigt/.test(x));
    products.push({
      product_id: unitId,
      name: t[0] ?? null,
      brand: t[1] && !/^[\d.,]+$/.test(t[1]) && !/benötigt/.test(t[1]) ? t[1] : null,
      price: su ? su.price / 100 : null,
      needed: need ? need.replace(/[()]/g, "").replace(/ benötigt/, "") : null,
      available: st ? st.isAvailable !== false : null,
      kind: st?.ingredientType ?? null,
    });
  }

  const section = (start: string, stops: string[]) => {
    const i = all.findIndex((t) => t === start);
    if (i < 0) return [];
    let j = all.length;
    for (const s of stops) { const k = all.findIndex((t, idx) => idx > i && (t === s || t.startsWith(s))); if (k > 0 && k < j) j = k; }
    return all.slice(i + 1, j);
  };

  const nutRaw = section("**Nährwerte**", ["**Allergene**"]).slice(1);
  const nutrition: Record<string, string> = {};
  for (let i = 0; i + 1 < nutRaw.length; i += 2) nutrition[nutRaw[i]] = nutRaw[i + 1];

  const ai = at("**Allergene**");
  const allergens = ai >= 0 ? all[ai + 1] : null;

  const zi = all.findIndex((t, i) => t === "Zutaten" && i > ai);
  const stepStart = at("So wird's gemacht");
  const ingredientLines = zi >= 0 && stepStart > zi ? all.slice(zi + 1, stepStart) : [];
  const ingredients = ingredientLines
    .filter((l) => !l.startsWith("**Eigene Zutaten"))
    .map((l) => { const m = l.match(/^\*\*(.+?)\*\*\s*(.*)$/); return m ? { name: m[1], amount: m[2] || null } : { name: l, amount: null }; });
  const own = ingredientLines.find((l) => l.startsWith("**Eigene Zutaten"))?.replace(/^\*\*Eigene Zutaten:\*\*\s*/, "") ?? null;

  const steps: string[] = [];
  let servings: string | null = null;
  let tip: string | null = null;
  if (stepStart >= 0) {
    for (let i = stepStart + 1; i < all.length; i++) {
      const t = all[i];
      if (/^\d+ Portionen?$/.test(t)) servings = t;
      else if (/^Schritt \d+$/.test(t)) steps.push(strip(all[++i] ?? "").replace(/\*\*/g, ""));
      else if (t === "Tipp") { tip = strip(all[i + 1] ?? "").replace(/\*\*/g, ""); break; }
    }
  }

  return {
    recipe_id: id,
    title,
    intro,
    time,
    portions: portions ?? servings,
    image_id: heroId,
    image_url: imageUrl(base, heroId, "large"),
    ingredients,
    own_kitchen_ingredients: own,
    products_to_buy: products,
    nutrition_per_portion: nutrition,
    allergens,
    steps,
    tip,
  };
}

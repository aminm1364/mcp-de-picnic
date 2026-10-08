import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { Env, PicnicClient, PicnicError } from "./picnic";
import { authHandler } from "./auth";

function buildServer(env: Env) {
  const picnic = new PicnicClient(env);
  const server = new McpServer({ name: "picnic", version: "0.1.0" });
  const run = (fn: () => Promise<unknown>) => async () => {
    try {
      const r = await fn();
      return { content: [{ type: "text" as const, text: JSON.stringify(r ?? { ok: true }) }] };
    } catch (e) {
      const msg = e instanceof PicnicError ? e.message : "Unexpected error.";
      return { isError: true, content: [{ type: "text" as const, text: msg }] };
    }
  };
  server.tool("search_products", "Search Picnic products", { query: z.string() }, ({ query }) => run(() => picnic.searchProducts(query))());
  server.tool("get_cart", "Get the current cart", {}, run(() => picnic.getCart()));
  server.tool("add_to_cart", "Add a product to the cart", { product_id: z.string(), count: z.number().int().min(1).default(1) }, ({ product_id, count }) => run(() => picnic.addToCart(product_id, count))());
  server.tool("remove_from_cart", "Remove a product from the cart", { product_id: z.string(), count: z.number().int().min(1).default(1) }, ({ product_id, count }) => run(() => picnic.removeFromCart(product_id, count))());
  server.tool("clear_cart", "Empty the cart", {}, run(() => picnic.clearCart()));
  server.tool("get_delivery_slots", "List delivery slots; 'suggested' marks Picnic's pick", {}, run(() => picnic.getDeliverySlots()));
  server.tool("set_delivery_slot", "Select a delivery slot", { slot_id: z.string() }, ({ slot_id }) => run(() => picnic.setDeliverySlot(slot_id))());
  server.tool("generate_2fa_code", "Ask Picnic to send a 2FA code (SMS)", {}, run(() => picnic.generate2fa("SMS")));
  server.tool("verify_2fa_code", "Submit the 2FA code", { code: z.string() }, ({ code }) => run(() => picnic.verify2fa(code))());
  server.tool("search_recipes", "Search Picnic meals/recipes (Rezepte). Returns recipe_id, title/time label and image_url.", { query: z.string(), limit: z.number().int().min(1).max(50).default(20) }, ({ query, limit }) => run(() => picnic.searchRecipes(query, limit))());
  server.tool("list_recipes", "List recipes from a Picnic meals tab: cookbook (Alle Rezepte), weekly_suggestions (Wochenplan), or ordered (Bestellt).", { section: z.enum(["cookbook", "weekly_suggestions", "ordered"]).default("cookbook"), limit: z.number().int().min(1).max(100).default(40) }, ({ section, limit }) => run(() => picnic.listRecipes(section, limit))());
  server.tool("get_recipe", "Full recipe: description, time, portions, ingredients, products to buy (with product_id for add_to_cart), nutrition, allergens, cooking steps, tip, image_url.", { recipe_id: z.string() }, ({ recipe_id }) => run(() => picnic.getRecipe(recipe_id))());
  server.tool("get_image", "Fetch a product or recipe image as an image (use image_id from other tools).", { image_id: z.string(), size: z.enum(["tiny", "small", "medium", "large"]).default("medium") }, async ({ image_id, size }) => {
    try {
      return { content: [{ type: "image" as const, data: await picnic.fetchImage(image_id, size), mimeType: "image/png" }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: e instanceof PicnicError ? e.message : "Unexpected error." }] };
    }
  });
  return server;
}

const mcpApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return createMcpHandler(buildServer(env), { route: "/mcp" })(request, env, ctx);
  },
};

// The provider is built per request so the public hostname can come from configuration (PUBLIC_HOST var).
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const host = env.PUBLIC_HOST || new URL(request.url).host;
    return new OAuthProvider({
      apiHandlers: { "/mcp": mcpApi },
      defaultHandler: authHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      resourceMetadata: {
        resource: `https://${host}/mcp`,
        authorization_servers: [`https://${host}`],
        resource_name: "Picnic MCP",
      },
    }).fetch(request, env, ctx);
  },
};

import { request } from "undici";
import { env } from "../config/env.js";
import { NotConfiguredError, ProviderError } from "../utils/errors.js";

function requireConfig(): { domain: string; token: string } {
  if (!env.SHOPIFY_SHOP_DOMAIN || !env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
    throw new NotConfiguredError("Shopify integration (SHOPIFY_SHOP_DOMAIN + SHOPIFY_ADMIN_ACCESS_TOKEN)");
  }
  return { domain: env.SHOPIFY_SHOP_DOMAIN, token: env.SHOPIFY_ADMIN_ACCESS_TOKEN };
}

async function shopifyRequest(path: string, init?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown }) {
  const { domain, token } = requireConfig();
  const res = await request(`https://${domain}/admin/api/2024-10${path}`, {
    method: init?.method ?? "GET",
    headers: { "X-Shopify-Access-Token": token, "content-type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.body.json().catch(() => undefined);
  if (res.statusCode >= 400) {
    throw new ProviderError(`Shopify API error (${res.statusCode}): ${JSON.stringify(body)}`, res.statusCode >= 500);
  }
  return body;
}

// Section 37: real Shopify Admin API integration. shopify.read (orders,
// products, inventory) vs shopify.write (updating a product/inventory) is
// enforced at the tool-permission layer, not here.
export const shopifyIntegration = {
  isConfigured: () => Boolean(env.SHOPIFY_SHOP_DOMAIN && env.SHOPIFY_ADMIN_ACCESS_TOKEN),

  async getShopInfo() {
    return shopifyRequest("/shop.json");
  },

  async listOrders(limit = 20) {
    return shopifyRequest(`/orders.json?limit=${limit}&status=any`);
  },

  async listProducts(limit = 20) {
    return shopifyRequest(`/products.json?limit=${limit}`);
  },

  async getInventoryLevels(inventoryItemIds: string[]) {
    return shopifyRequest(`/inventory_levels.json?inventory_item_ids=${inventoryItemIds.join(",")}`);
  },

  async updateProduct(productId: string, updates: Record<string, unknown>) {
    return shopifyRequest(`/products/${productId}.json`, { method: "PUT", body: { product: { id: productId, ...updates } } });
  },
};

import { createHash } from "node:crypto";
import { ANY_STATUS_QUERY } from "./core/filters";
import type { Gateway } from "./core/gateway";
import { GatewayError } from "./core/gateway";
import type { AttributeValue, GlobalAttributeDefinition, ProductState, ShopSettings } from "./core/types";
import { log } from "./log.server";

/**
 * The Shopify Admin GraphQL gateway. Every query is a fixed document with variables: nothing from the
 * browser is ever spliced into GraphQL. Reads retry on throttling and transient errors with bounded
 * exponential backoff; writes are never retried, because the engine decides their outcome by reading back.
 */

export interface AdminClient {
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<Response>;
}

const TEXT_TYPES = ["single_line_text_field", "list.single_line_text_field"];
const PAGE = 25; // Keeps a fully-loaded product page well under the 1,000-point query cost limit.

const PRODUCT_FIELDS = `#graphql
  fragment CartovumProduct on Product {
    id title handle status vendor productType tags descriptionHtml templateSuffix hasOnlyDefaultVariant
    category { id }
    featuredMedia { preview { image { url(transform: { maxWidth: 80 }) } } }
    options { name optionValues { name } }
    media(first: 50) { nodes { id } }
    collections(first: 50) { nodes { id } }
    metafields(first: 100) { nodes { namespace key type value } }
    variants(first: 100) {
      nodes {
        id title sku price compareAtPrice barcode inventoryPolicy
        selectedOptions { name value }
        inventoryItem {
          id tracked
          inventoryLevels(first: 20) { nodes { location { id } quantities(names: ["on_hand", "available"]) { name quantity } } }
        }
      }
    }
  }`;

const SEARCH = `#graphql
  ${PRODUCT_FIELDS}
  query CartovumSearch($query: String, $first: Int!, $after: String) {
    products(first: $first, after: $after, query: $query, sortKey: ID) {
      nodes { ...CartovumProduct }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const BY_IDS = `#graphql
  ${PRODUCT_FIELDS}
  query CartovumProducts($ids: [ID!]!) { nodes(ids: $ids) { ...CartovumProduct } }`;

const DEFINITIONS = `#graphql
  query CartovumDefinitions($after: String) {
    metafieldDefinitions(ownerType: PRODUCT, first: 250, after: $after) {
      nodes { namespace key name type { name } validations { name value } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const LOCAL_SCAN = `#graphql
  query CartovumLocalScan($after: String, $namespace: String!, $query: String!) {
    products(first: 100, after: $after, query: $query, sortKey: ID) {
      nodes { metafields(first: 50, namespace: $namespace) { nodes { key type value } } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const COLLECTIONS = `#graphql
  query CartovumCollections($after: String) {
    collections(first: 250, after: $after, sortKey: TITLE) { nodes { id title } pageInfo { hasNextPage endCursor } }
  }`;

const PRODUCT_TYPES = `#graphql
  query CartovumProductTypes { productTypes(first: 1000) { nodes } }`;

const PRODUCT_TAGS = `#graphql
  query CartovumProductTags { productTags(first: 5000) { nodes } }`;

const SET_TRACKED = `#graphql
  mutation CartovumTracked($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id tracked } userErrors { field message } }
  }`;

const SET_POLICY = `#graphql
  mutation CartovumPolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id inventoryPolicy } userErrors { field message } }
  }`;

const METAFIELDS_SET = `#graphql
  mutation CartovumMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { key namespace } userErrors { field message code } }
  }`;

const METAFIELDS_DELETE = `#graphql
  mutation CartovumMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { deletedMetafields { key namespace } userErrors { field message } }
  }`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export class ShopifyGateway implements Gateway {
  private globalsCache: Promise<GlobalAttributeDefinition[]> | null = null;

  constructor(
    private admin: AdminClient,
    private settings: ShopSettings,
    private shop: string,
  ) {}

  /** A read: retried on throttling / 5xx / network errors, at most 5 attempts. */
  private async read(query: string, variables: Record<string, unknown>): Promise<Json> {
    let delay = 500;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.admin.graphql(query, { variables });
        const body = (await res.json()) as Json;
        const throttled = body.errors?.some?.((e: Json) => e.extensions?.code === "THROTTLED");
        if (throttled) throw Object.assign(new Error("Throttled by Shopify"), { transient: true });
        if (body.errors?.length) throw new GatewayError(body.errors.map((e: Json) => e.message).join("; "));
        return body.data;
      } catch (e) {
        const err = e as Error & { transient?: boolean; response?: { code?: number } };
        const status = err.response?.code ?? 0;
        const transient = err.transient || status === 429 || status >= 500 || /fetch|network|ECONN|timeout/i.test(err.message);
        if (!transient || attempt >= 5) {
          log("shopify.read_error", { shop: this.shop, attempt, message: err.message });
          throw err instanceof GatewayError ? err : new GatewayError(err.message);
        }
        await sleep(delay + Math.floor(Math.random() * 250));
        delay *= 2;
      }
    }
  }

  /** A write: one attempt. Transport failures are marked uncertain; the engine reads back to decide. */
  private async write(query: string, variables: Record<string, unknown>, field: string): Promise<Json> {
    let body: Json;
    try {
      const res = await this.admin.graphql(query, { variables });
      body = (await res.json()) as Json;
    } catch (e) {
      log("shopify.write_uncertain", { shop: this.shop, field, message: (e as Error).message });
      throw new GatewayError((e as Error).message, true);
    }
    if (body.errors?.length) throw new GatewayError(body.errors.map((e: Json) => e.message).join("; "));
    const errors = body.data?.[field]?.userErrors ?? [];
    if (errors.length) {
      log("shopify.user_errors", { shop: this.shop, field, errors });
      throw new GatewayError(errors.map((e: Json) => e.message).join("; "));
    }
    return body.data[field];
  }

  private async toState(node: Json): Promise<ProductState> {
    const globals = await this.getGlobalAttributes();
    const attributes: AttributeValue[] = [];
    for (const m of node.metafields.nodes as Json[]) {
      if (!TEXT_TYPES.includes(m.type)) continue;
      const key = `${m.namespace}.${m.key}`;
      const kind = globals.some((g) => g.key === key) ? "global" : this.settings.localNamespaces.includes(m.namespace) ? "local" : null;
      if (!kind) continue;
      const values = m.type.startsWith("list.") ? (JSON.parse(m.value) as string[]) : [m.value];
      attributes.push({ key, kind, type: m.type, values });
    }
    return {
      id: node.id,
      title: node.title,
      handle: node.handle,
      status: node.status,
      vendor: node.vendor ?? "",
      productType: node.productType ?? "",
      tags: node.tags ?? [],
      descriptionHash: createHash("md5").update(node.descriptionHtml ?? "").digest("hex"),
      templateSuffix: node.templateSuffix ?? "",
      categoryId: node.category?.id ?? "",
      collectionIds: node.collections.nodes.map((c: Json) => c.id),
      mediaIds: node.media.nodes.map((m: Json) => m.id),
      imageUrl: node.featuredMedia?.preview?.image?.url,
      hasOnlyDefaultVariant: node.hasOnlyDefaultVariant,
      options: node.options.map((o: Json) => ({ name: o.name, values: o.optionValues.map((v: Json) => v.name) })),
      attributes,
      variants: node.variants.nodes.map((v: Json) => ({
        id: v.id,
        title: v.title,
        sku: v.sku ?? "",
        price: v.price ?? "",
        compareAtPrice: v.compareAtPrice ?? "",
        barcode: v.barcode ?? "",
        inventoryPolicy: v.inventoryPolicy,
        inventoryItemId: v.inventoryItem.id,
        tracked: v.inventoryItem.tracked,
        selectedOptions: v.selectedOptions,
        levels: v.inventoryItem.inventoryLevels.nodes.map((l: Json) => {
          const q = (name: string) => l.quantities.find((x: Json) => x.name === name)?.quantity ?? 0;
          return { locationId: l.location.id, onHand: q("on_hand"), available: q("available") };
        }),
      })),
    };
  }

  async searchProducts(query: string, first: number, after: string | null) {
    const data = await this.read(SEARCH, { query: query || null, first: Math.min(first, PAGE), after });
    const products = await Promise.all(data.products.nodes.map((n: Json) => this.toState(n)));
    return { products, endCursor: data.products.pageInfo.endCursor, hasNextPage: data.products.pageInfo.hasNextPage };
  }

  async getProducts(ids: string[]) {
    const out: ProductState[] = [];
    for (let i = 0; i < ids.length; i += PAGE) {
      const data = await this.read(BY_IDS, { ids: ids.slice(i, i + PAGE) });
      for (const n of data.nodes as Json[]) if (n?.id) out.push(await this.toState(n));
    }
    return out;
  }

  async countProducts(query: string): Promise<number | null> {
    const data = await this.read(`#graphql
      query CartovumCount($query: String) { productsCount(query: $query, limit: null) { count precision } }`, { query: query || null });
    return data.productsCount.precision === "EXACT" ? data.productsCount.count : null;
  }

  getGlobalAttributes() {
    this.globalsCache ??= (async () => {
      const out: GlobalAttributeDefinition[] = [];
      let after: string | null = null;
      do {
        const data = await this.read(DEFINITIONS, { after });
        for (const d of data.metafieldDefinitions.nodes as Json[]) {
          const choices = d.validations.find((v: Json) => v.name === "choices");
          if (!TEXT_TYPES.includes(d.type.name) || !choices) continue;
          out.push({ key: `${d.namespace}.${d.key}`, label: d.name, type: d.type.name, choices: JSON.parse(choices.value) });
        }
        after = data.metafieldDefinitions.pageInfo.hasNextPage ? data.metafieldDefinitions.pageInfo.endCursor : null;
      } while (after);
      return out;
    })();
    return this.globalsCache;
  }

  /** One scan of up to 10,000 products per local namespace (as v1.3.9), at most 300 values per attribute. */
  async getLocalAttributeValues() {
    const counts: Record<string, Record<string, number>> = {};
    for (const namespace of this.settings.localNamespaces) {
      let after: string | null = null;
      let scanned = 0;
      do {
        // Every status, so values used only on draft, archived or unlisted products are offered too.
        const data = await this.read(LOCAL_SCAN, { after, namespace, query: ANY_STATUS_QUERY });
        for (const p of data.products.nodes as Json[])
          for (const m of p.metafields.nodes as Json[]) {
            if (!TEXT_TYPES.includes(m.type)) continue;
            const key = `${namespace}.${m.key}`;
            const values: string[] = m.type.startsWith("list.") ? JSON.parse(m.value) : [m.value];
            counts[key] ??= {};
            for (const v of new Set(values.map((x) => x.trim()).filter(Boolean))) counts[key][v] = (counts[key][v] ?? 0) + 1;
          }
        scanned += data.products.nodes.length;
        after = data.products.pageInfo.hasNextPage && scanned < 10000 ? data.products.pageInfo.endCursor : null;
      } while (after);
    }
    const out: Record<string, { value: string; count: number }[]> = {};
    for (const [key, values] of Object.entries(counts)) {
      out[key] = Object.entries(values)
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
        .slice(0, 300)
        .map(([value, count]) => ({ value, count }));
    }
    return out;
  }

  async getCollections() {
    const out: { id: string; title: string }[] = [];
    let after: string | null = null;
    do {
      const data = await this.read(COLLECTIONS, { after });
      out.push(...data.collections.nodes);
      after = data.collections.pageInfo.hasNextPage && out.length < 2500 ? data.collections.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  /** Suggestions only: the filters accept any value, so a very long list being cut off loses nothing. */
  async getProductTypes() {
    return ((await this.read(PRODUCT_TYPES, {})).productTypes.nodes as string[]).filter(Boolean);
  }

  async getProductTags() {
    return ((await this.read(PRODUCT_TAGS, {})).productTags.nodes as string[]).filter(Boolean);
  }

  async setInventoryTracked(inventoryItemId: string, tracked: boolean) {
    await this.write(SET_TRACKED, { id: inventoryItemId, input: { tracked } }, "inventoryItemUpdate");
  }

  async setInventoryPolicy(productId: string, variantId: string, policy: "DENY" | "CONTINUE") {
    await this.write(SET_POLICY, { productId, variants: [{ id: variantId, inventoryPolicy: policy }] }, "productVariantsBulkUpdate");
  }

  async writeAttributes(productId: string, set: AttributeValue[], remove: string[]) {
    const split = (key: string) => ({ namespace: key.split(".")[0], key: key.split(".")[1] });
    if (set.length) {
      await this.write(
        METAFIELDS_SET,
        {
          metafields: set.map((a) => ({
            ownerId: productId,
            ...split(a.key),
            type: a.type,
            value: a.type.startsWith("list.") ? JSON.stringify(a.values) : a.values[0] ?? "",
          })),
        },
        "metafieldsSet",
      );
    }
    if (remove.length) {
      await this.write(METAFIELDS_DELETE, { metafields: remove.map((k) => ({ ownerId: productId, ...split(k) })) }, "metafieldsDelete");
    }
  }
}

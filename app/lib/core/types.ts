/**
 * Domain types shared by the engine, the Shopify gateway and the UI.
 *
 * The engine never talks to Shopify directly. It works on ProductState, a canonical, already-normalised
 * view of one product, and asks a Gateway to read and write. That keeps every safety rule testable
 * against an in-memory store with failure injection.
 */

export type StockStatus = "instock" | "outofstock" | "onbackorder";
export const STOCK_STATUSES: StockStatus[] = ["instock", "outofstock", "onbackorder"];

export type ProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED";
export const PRODUCT_STATUSES: ProductStatus[] = ["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"];

export type ResultStatus = "changed" | "skipped" | "failed";

export interface InventoryLevel {
  locationId: string;
  onHand: number;
  available: number;
}

export interface VariantState {
  id: string;
  title: string;
  sku: string;
  price: string;
  compareAtPrice: string;
  barcode: string;
  /** DENY = stop selling at zero, CONTINUE = keep selling (backorder). */
  inventoryPolicy: "DENY" | "CONTINUE";
  inventoryItemId: string;
  tracked: boolean;
  levels: InventoryLevel[];
  selectedOptions: { name: string; value: string }[];
}

export interface ProductOption {
  name: string;
  values: string[];
}

/**
 * One attribute value set on a product. Global attributes are product metafields whose definition
 * restricts values to a fixed list of choices (the Shopify stand-in for WooCommerce terms). Local
 * attributes are free-text product metafields in the app's local namespaces.
 */
export interface AttributeValue {
  /** "namespace.key" of the metafield. */
  key: string;
  kind: "global" | "local";
  /** Metafield type as stored, kept so a write or restore uses the same type. */
  type: "single_line_text_field" | "list.single_line_text_field";
  values: string[];
}

export interface ProductState {
  id: string;
  title: string;
  handle: string;
  status: ProductStatus;
  vendor: string;
  productType: string;
  tags: string[];
  descriptionHash: string;
  templateSuffix: string;
  categoryId: string;
  collectionIds: string[];
  mediaIds: string[];
  options: ProductOption[];
  variants: VariantState[];
  /** True when Shopify reports the product has only its default variant (a "simple" product). */
  hasOnlyDefaultVariant: boolean;
  attributes: AttributeValue[];
  imageUrl?: string;
}

/** A global attribute: a product metafield definition with a fixed list of allowed values. */
export interface GlobalAttributeDefinition {
  key: string;
  label: string;
  type: AttributeValue["type"];
  choices: string[];
}

export interface Filters {
  search: string;
  skus: string[];
  collectionId: string;
  stockStatus: StockStatus | "";
  status: ProductStatus | "";
  conditions: AttributeCondition[];
  perPage: number;
}

/** attribute is "namespace.key" for metafields, or "option:<name>" for a product option. */
export interface AttributeCondition {
  attribute: string;
  value: string;
}

export interface ResultRow {
  id: string;
  sku: string;
  name: string;
  status: ResultStatus;
  message: string;
  before?: unknown;
  after?: unknown;
}

export type AttributeOpKind = "add_terms" | "remove_terms" | "set_terms" | "remove_attribute" | "set_local_value";
export const ATTRIBUTE_OPS: AttributeOpKind[] = ["add_terms", "remove_terms", "set_terms", "remove_attribute", "set_local_value"];

export interface AttributeOp {
  op: AttributeOpKind;
  attribute: string;
  isLocal: boolean;
  label: string;
  terms: string[];
  value: string;
  type: AttributeValue["type"];
}

/** Per-shop settings that change behaviour. Defaults preserve v1.3.9 exactly. */
export interface ShopSettings {
  localNamespaces: string[];
  /** v1.3.9 leaves variable products alone for every operation. Kept on by default. */
  protectMultiVariantProducts: boolean;
  keepJobs: number;
  selectAllCap: number;
  convertWritesEnabled: boolean;
  convertAllowedStatuses: ProductStatus[];
  convertAllowedIds: string[];
}

export const DEFAULT_SETTINGS: ShopSettings = {
  localNamespaces: ["cartovum_local"],
  protectMultiVariantProducts: true,
  keepJobs: 25,
  selectAllCap: 50000,
  convertWritesEnabled: false,
  convertAllowedStatuses: [],
  convertAllowedIds: [],
};

export const BATCH_SIZE = 10;
export const MAX_PER_REQUEST = 25;
export const MAX_CONDITIONS = 10;
export const MAX_SKUS = 500;

/** GraphQL documents used only by the development-store seed. Fixed text; every value is a variable. */

export const PREFLIGHT = `#graphql
  query CartovumSeedPreflight($all: String!, $seeded: String!, $collections: String!) {
    shop { myshopifyDomain }
    locations(first: 5) { nodes { id name isActive } }
    all: productsCount(query: $all, limit: null) { count precision }
    seeded: productsCount(query: $seeded, limit: null) { count precision }
    existing: products(first: 100, query: $seeded) { nodes { id handle tags } }
    metafieldDefinitions(ownerType: PRODUCT, namespace: "shared", first: 50) {
      nodes { key name type { name } validations { name value } }
    }
    collections(first: 10, query: $collections) { nodes { id handle title } }
  }`;

export const CREATE_DEFINITION = `#graphql
  mutation CartovumSeedDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key }
      userErrors { field message code }
    }
  }`;

export const CREATE_COLLECTION = `#graphql
  mutation CartovumSeedCollection($collection: CollectionCreateInput!) {
    collectionCreate(collection: $collection) {
      collection { id handle }
      userErrors { field message }
    }
  }`;

/** One document with `count` aliased productSet calls, so a chunk of products costs one CLI call. */
export function productSetChunk(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$id${i}: ProductSetIdentifiers, $in${i}: ProductSetInput!`).join(", ");
  const calls = Array.from(
    { length: count },
    (_, i) => `    p${i}: productSet(identifier: $id${i}, input: $in${i}, synchronous: true) {
      product { id handle }
      userErrors { field message code }
    }`,
  ).join("\n");
  return `#graphql
  mutation CartovumSeedProducts(${vars}) {
${calls}
  }`;
}

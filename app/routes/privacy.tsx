import type { MetaFunction } from "react-router";
import { APP_NAME, POLICY_UPDATED, PublicPage, SUPPORT_URL } from "../components/public-page";

export const meta: MetaFunction = () => [{ title: `Privacy policy — ${APP_NAME}` }];

export default function Privacy() {
  return (
    <PublicPage title="Privacy policy">
      <p>Last updated: {POLICY_UPDATED}</p>
      <p>
        {APP_NAME} (&quot;the app&quot;) is a Shopify app developed by Cartovum Agency. This policy explains what the app accesses, what it stores, why, for how long, and how it is deleted.
      </p>

      <h2>What the app accesses</h2>
      <p>The app works on your store&apos;s product catalogue only. It requests two Shopify permissions:</p>
      <ul>
        <li><strong>Products</strong> (write_products, which includes read access): products, variants, collections, product types, tags and product metafields, to search and filter them and to make the changes you ask for.</li>
        <li><strong>Inventory</strong> (write_inventory, which includes read access): whether a variant tracks inventory and its quantities, to set stock status and to protect quantity-managed products.</li>
      </ul>
      <p>The app does not request access to customers, orders, payments or any other data, and never changes inventory quantities.</p>

      <h2>What the app stores</h2>
      <ul>
        <li><strong>Sessions</strong>: the access tokens Shopify issues to the app, and the name and email of the staff member using it (provided by Shopify), so the app can act on your behalf and record who started each run.</li>
        <li><strong>Run history</strong>: for each run, what was asked for, when, by whom, and for each product changed, its state before and after <em>only in the fields the run changed</em> (stock settings, or the attribute being edited). This is what makes Put Back possible. Full product records are not stored.</li>
        <li><strong>Settings and conversion decisions</strong> you make in the app.</li>
      </ul>
      <p>The app stores no customer personal data.</p>

      <h2>How long it is kept</h2>
      <ul>
        <li>Run history: the newest runs only (25 by default, adjustable in the app&apos;s settings); older runs are deleted with their per-product records.</li>
        <li>Everything held for your store is deleted when Shopify asks the app to erase your store&apos;s data, which Shopify does 48 hours after you uninstall the app. Access tokens are deleted as soon as the app is uninstalled.</li>
      </ul>

      <h2>Sharing</h2>
      <p>The app does not sell or share your data. It is processed only to provide the app&apos;s features, on servers operated for Cartovum Agency, and exchanged only with Shopify through Shopify&apos;s Admin API.</p>

      <h2>Your requests</h2>
      <p>
        Shopify forwards customer data and erasure requests to the app; because the app holds no customer data, there is nothing to return or erase. For any other question or request about your store&apos;s data, contact us through{" "}
        <a href={SUPPORT_URL}>cartovumagency.com/contact</a>.
      </p>
    </PublicPage>
  );
}

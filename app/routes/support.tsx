import type { MetaFunction } from "react-router";
import { APP_NAME, PublicPage, SUPPORT_URL } from "../components/public-page";

export const meta: MetaFunction = () => [{ title: `Support — ${APP_NAME}` }];

export default function Support() {
  return (
    <PublicPage title="Support">
      <p>
        Contact Cartovum Agency through <a href={SUPPORT_URL}>cartovumagency.com/contact</a>.
      </p>
      <p>To help us answer quickly, include:</p>
      <ul>
        <li>your store&apos;s address (<em>your-store</em>.myshopify.com);</li>
        <li>what you were doing, and what you expected to happen;</li>
        <li>for a run: the time it was started, and the result shown for the product in question (open the run from Run history).</li>
      </ul>

      <h2>Common questions</h2>
      <h3>A product was skipped. Why?</h3>
      <p>Every skipped product shows its reason in the run&apos;s results — for example a product with variants, inventory that tracks a quantity, or a value that is already set.</p>
      <h3>Can I undo a run?</h3>
      <p>Yes: open the run from Run history and choose Put Back. Products changed since the run are left as they are and listed, so later edits are never overwritten.</p>
      <h3>Does the app change inventory quantities?</h3>
      <p>No. Stock status is set through inventory tracking and the &quot;continue selling when out of stock&quot; setting only; products whose quantity decides their stock are skipped.</p>
    </PublicPage>
  );
}

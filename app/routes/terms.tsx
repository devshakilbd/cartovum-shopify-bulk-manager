import type { MetaFunction } from "react-router";
import { APP_NAME, POLICY_UPDATED, PublicPage, SUPPORT_URL } from "../components/public-page";

export const meta: MetaFunction = () => [{ title: `Terms of service — ${APP_NAME}` }];

export default function Terms() {
  return (
    <PublicPage title="Terms of service">
      <p>Last updated: {POLICY_UPDATED}</p>
      <p>These terms apply to your use of {APP_NAME} (&quot;the app&quot;), provided by Cartovum Agency, on your Shopify store. By installing the app you agree to them.</p>

      <h2>What the app does</h2>
      <p>
        The app changes product data in your store when you start a run: stock status and product attributes. It changes only what you ask for, checks every product afterwards, and records each run so it can be put back. A product changed by someone else after a run is left as it is when you put that run back.
      </p>

      <h2>Your responsibilities</h2>
      <ul>
        <li>Review the preview before confirming a run, and use the results and Put Back to correct anything you did not intend.</li>
        <li>Give access to the app only to staff who should be able to change products; the app also checks each staff member&apos;s own Shopify permissions.</li>
        <li>Keep your own backups of product data you cannot afford to lose.</li>
      </ul>

      <h2>Availability and changes</h2>
      <p>We work to keep the app available and correct, but it is provided &quot;as is&quot;, without warranties beyond those required by law. We may update the app and these terms; material changes will be shown on this page with a new date.</p>

      <h2>Liability</h2>
      <p>To the extent the law allows, Cartovum Agency is not liable for indirect or consequential losses arising from use of the app, including lost sales from product data changes you started.</p>

      <h2>Ending use</h2>
      <p>You can stop using the app at any time by uninstalling it. Data is then deleted as described in the <a href="/privacy">privacy policy</a>.</p>

      <h2>Contact</h2>
      <p>
        <a href={SUPPORT_URL}>cartovumagency.com/contact</a>
      </p>
    </PublicPage>
  );
}

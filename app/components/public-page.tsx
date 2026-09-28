import type { ReactNode } from "react";
import { Link } from "react-router";

/**
 * Layout for the app's public pages (landing, privacy, terms, support). These pages need no Shopify
 * session: they are what the App Store listing and reviewers link to.
 */
export const APP_NAME = "Cartovum Bulk Product Manager";
export const SUPPORT_URL = "https://cartovumagency.com/contact/";
export const POLICY_UPDATED = "28 September 2026";

const page: React.CSSProperties = { maxWidth: 760, margin: "0 auto", padding: "32px 16px 64px", fontFamily: "Inter, -apple-system, 'Segoe UI', sans-serif", lineHeight: 1.6, color: "#1a1a1a" };

export function PublicPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main style={page}>
      <nav aria-label="Pages" style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 14, marginBottom: 24 }}>
        <Link to="/">{APP_NAME}</Link>
        <Link to="/privacy">Privacy policy</Link>
        <Link to="/terms">Terms of service</Link>
        <Link to="/support">Support</Link>
      </nav>
      <h1 style={{ fontSize: 28, lineHeight: 1.25 }}>{title}</h1>
      {children}
      <footer style={{ marginTop: 48, fontSize: 13, color: "#616161" }}>{APP_NAME} is developed by Cartovum Agency.</footer>
    </main>
  );
}

// Google sign-in in front of the MCP OAuth server. Only ALLOWED_EMAIL gets a token.
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./picnic";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const html = (body: string, headers?: Headers, status = 200) => {
  const h = new Headers(headers);
  h.set("Content-Type", "text/html; charset=utf-8");
  return new Response(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Picnic MCP</title><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">${body}`, { status, headers: h });
};

export const authHandler: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;

    if (url.pathname === "/authorize" && request.method === "GET") {
      const authReq = await oauth.parseAuthRequest(request);
      const info = await oauth.describeConsent(authReq);
      const tx = await oauth.beginConsent(authReq);
      return html(
        `<h2>Connect to Picnic (DE)?</h2><p><b>${esc(info.clientName ?? "An MCP client")}</b> wants to use your Picnic cart. It will receive tokens at <b>${esc(info.redirectHost)}</b>.</p>
        <form method=post action=/authorize><input type=hidden name=handle value="${esc(tx.handle)}">
        <button name=decision value=allow>Continue with Google</button> <button name=decision value=deny>Cancel</button></form>`,
        tx.headers,
      );
    }

    if (url.pathname === "/authorize" && request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "allow") {
        const d = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: d.headers });
      }
      const approved = await oauth.approveConsent(request, handle);
      const tx = await oauth.beginUpstream(approved.request, { headers: approved.headers });
      const g = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      g.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: url.origin + "/callback",
        response_type: "code",
        scope: "openid email",
        state: tx.state,
        prompt: "select_account",
      }).toString();
      tx.headers.set("Location", g.toString());
      return new Response(null, { status: 302, headers: tx.headers });
    }

    if (url.pathname === "/callback") {
      let resumed;
      try {
        resumed = await oauth.finishUpstream<unknown>(request);
      } catch {
        return html("<h2>Sign-in expired</h2><p>Start the connection again from your client.</p>", undefined, 400);
      }
      const code = url.searchParams.get("code");
      if (!code) return html("<h2>Sign-in failed</h2>", resumed.headers, 400);
      const tok = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: url.origin + "/callback",
          grant_type: "authorization_code",
        }),
      });
      if (!tok.ok) return html("<h2>Google sign-in failed</h2>", resumed.headers, 502);
      const { access_token } = (await tok.json()) as { access_token: string };
      const ui = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${access_token}` } });
      const me = (await ui.json()) as { email?: string; email_verified?: boolean };
      if (!me.email || !me.email_verified || me.email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) {
        return html("<h2>Not allowed</h2><p>This server is private.</p>", resumed.headers, 403);
      }
      const { redirectTo } = await oauth.completeAuthorization({
        request: resumed.request as AuthRequest,
        userId: me.email,
        metadata: {},
        scope: resumed.request.scope,
        props: { email: me.email },
      });
      const h = new Headers(resumed.headers);
      h.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: h });
    }

    return new Response("Not found", { status: 404 });
  },
};

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { findMember } from "./members.js";

const html = (body: string, title = "Member Service Console") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title><style>
body{font:14px Arial,sans-serif;background:#d6d9df;margin:0;color:#111827}table{border-collapse:collapse}
.shell{width:760px;margin:28px auto;background:#fff;border:1px solid #667085}.bar{background:#17365d;color:#fff;padding:11px 16px;font-weight:bold}
.content{padding:20px}td{padding:8px;border:1px solid #98a2b3}label{font-weight:bold}input{padding:6px;width:220px}
button,a.button{display:inline-block;background:#315b86;color:#fff;border:0;padding:7px 13px;text-decoration:none;cursor:pointer}
.notice{padding:10px;border:1px solid #b42318;background:#fef3f2;color:#912018}.muted{color:#667085}
</style></head><body><div class="shell"><div class="bar">Northstar Core Banking — Member Service</div><div class="content">${body}</div></div></body></html>`;

const searchPage = (message = "") => html(`
  <p class="muted">Internal servicing console</p>${message}
  <form method="get" action="/members/search">
    <table><tr><td><label for="member-number">Member Number</label></td>
    <td><input id="member-number" name="memberId" inputmode="numeric" autocomplete="off"></td>
    <td><button type="submit">Search</button></td></tr></table>
  </form>`);

export function requestHandler(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("content-type", "text/html; charset=utf-8");

  if (url.pathname === "/" || url.pathname === "/members") {
    response.end(searchPage());
    return;
  }

  if (url.pathname === "/members/search") {
    const memberId = url.searchParams.get("memberId")?.trim() ?? "";
    const scenario = url.searchParams.get("scenario");
    if (scenario === "timeout") {
      response.statusCode = 503;
      response.setHeader("retry-after", "1");
      response.end(html('<div class="notice" role="alert">The host system did not respond. Try again.</div>'));
      return;
    }
    if (scenario === "denied") {
      response.statusCode = 403;
      response.end(html('<div class="notice" role="alert">Permission denied for member inquiry.</div>'));
      return;
    }
    const member = findMember(memberId);
    if (!member) {
      response.statusCode = 404;
      response.end(searchPage('<div class="notice" role="alert">No member found for that number.</div>'));
      return;
    }
    response.end(html(`<h1>Member Summary</h1><table aria-label="Member summary">
      <tr><td>Member Number</td><td>${member.id}</td></tr><tr><td>Name</td><td>${member.name}</td></tr>
      <tr><td>Savings</td><td><a class="button" href="/members/${member.id}/savings">View Account</a></td></tr></table>`));
    return;
  }

  const match = url.pathname.match(/^\/members\/(\d+)\/savings$/);
  const member = match?.[1] ? findMember(match[1]) : undefined;
  if (member) {
    response.end(html(`<h1>Savings Account</h1><table aria-label="Savings account">
      <tr><td>Member</td><td>${member.name}</td></tr><tr><td>Account Type</td><td>Regular Savings</td></tr>
      <tr><td>Current Balance</td><td data-field="current-balance">${member.savingsBalance}</td></tr></table>`));
    return;
  }

  response.statusCode = 404;
  response.end(html('<div class="notice" role="alert">Page not found.</div>'));
}

export function startTargetServer(port = 4173) {
  const server = createServer(requestHandler);
  return new Promise<typeof server>((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4173);
  startTargetServer(port).then(() => console.log(`Target app running at http://127.0.0.1:${port}`));
}

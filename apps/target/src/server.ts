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
.blocker{position:fixed;inset:0;background:rgba(17,24,39,.72);display:flex;align-items:center;justify-content:center;z-index:10}
.dialog{background:#fff;padding:24px;border:2px solid #17365d;max-width:360px}
</style></head><body><div class="shell"><div class="bar">Northstar Core Banking — Member Service</div><div class="content">${body}</div></div></body></html>`;

type TenantVariant = {
  basePath: string;
  idLabel: string;
  idField: string;
  searchLabel: string;
};

const baseTenant: TenantVariant = {
  basePath: "", idLabel: "Member Number", idField: "memberId", searchLabel: "Search"
};
const secondTenant: TenantVariant = {
  basePath: "/tenant-two", idLabel: "Customer ID", idField: "customerId", searchLabel: "Find Customer"
};

const searchPage = (variant: TenantVariant, message = "", memberId = "", scenario = "") => html(`
  <p class="muted">Internal servicing console</p>${message}
  <form method="get" action="${variant.basePath}/members/search">
    <table><tr><td><label for="member-number">${variant.idLabel}</label></td>
    <td><input id="member-number" name="${variant.idField}" value="${memberId}" inputmode="numeric" autocomplete="off"></td>
    <td><button type="submit">${variant.searchLabel}</button></td></tr></table>
    ${scenario ? `<input type="hidden" name="scenario" value="${scenario}">` : ""}
  </form>
  ${scenario === "blocked" ? `<div class="blocker" role="dialog" aria-label="Unexpected host notice">
    <div class="dialog"><p>An unexpected host notice is blocking automation.</p>
    <button type="button" onclick="this.closest('.blocker').remove()">Dismiss blocking dialog</button></div></div>` : ""}`);

export function createRequestHandler() {
  const transientAttempts = new Map<string, number>();
  return function requestHandler(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://localhost");
  const variant = url.pathname.startsWith(secondTenant.basePath) ? secondTenant : baseTenant;
  const route = variant === secondTenant ? url.pathname.slice(secondTenant.basePath.length) || "/" : url.pathname;
  response.setHeader("content-type", "text/html; charset=utf-8");

  if (route === "/" || route === "/members") {
    response.end(searchPage(variant, "", "", url.searchParams.get("scenario") ?? ""));
    return;
  }

  if (route === "/members/search") {
    const memberId = url.searchParams.get(variant.idField)?.trim() ?? "";
    const scenario = url.searchParams.get("scenario");
    if (scenario === "transient") {
      const attempts = transientAttempts.get(memberId) ?? 0;
      transientAttempts.set(memberId, attempts + 1);
      if (attempts === 0) {
        response.statusCode = 503;
        response.end(searchPage(variant, '<div class="notice" role="alert">Temporary host error. Retry the search.</div>', memberId, scenario));
        return;
      }
    }
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
      response.end(searchPage(variant, '<div class="notice" role="alert">No member found for that number.</div>', memberId, scenario ?? ""));
      return;
    }
    const summaryHeading = variant === secondTenant ? "Customer Overview" : "Member Summary";
    const summaryLabel = variant === secondTenant ? "Customer overview" : "Member summary";
    const savingsLink = variant === secondTenant ? "Open Deposit" : "View Account";
    response.end(html(`<h1>${summaryHeading}</h1><table aria-label="${summaryLabel}">
      <tr><td>Member Number</td><td data-sensitive>${member.id}</td></tr><tr><td>Name</td><td data-sensitive>${member.name}</td></tr>
      <tr><td>Savings</td><td><a class="button" href="${variant.basePath}/members/${member.id}/savings">${savingsLink}</a></td></tr></table>`));
    return;
  }

  const match = route.match(/^\/members\/(\d+)\/savings$/);
  const member = match?.[1] ? findMember(match[1]) : undefined;
  if (member) {
    const accountHeading = variant === secondTenant ? "Deposit Details" : "Savings Account";
    const accountLabel = variant === secondTenant ? "Deposit details" : "Savings account";
    const balanceField = variant === secondTenant ? "available-balance" : "current-balance";
    const balanceLabel = variant === secondTenant ? "Available Balance" : "Current Balance";
    response.end(html(`<h1>${accountHeading}</h1><table aria-label="${accountLabel}">
      <tr><td>Member</td><td data-sensitive>${member.name}</td></tr><tr><td>Account Type</td><td>Regular Savings</td></tr>
      <tr><td>${balanceLabel}</td><td data-field="${balanceField}">${member.savingsBalance}</td></tr></table>`));
    return;
  }

  response.statusCode = 404;
  response.end(html('<div class="notice" role="alert">Page not found.</div>'));
  };
}

export const requestHandler = createRequestHandler();

export function startTargetServer(port = 4173) {
  const server = createServer(createRequestHandler());
  return new Promise<typeof server>((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4173);
  startTargetServer(port).then(() => console.log(`Target app running at http://127.0.0.1:${port}`));
}

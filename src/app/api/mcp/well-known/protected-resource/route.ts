/** RFC 9728 — `/.well-known/oauth-protected-resource[/mcp]` (reescrita no middleware). */
import {
  mcpJson,
  preflight,
  protectedResourceMetadata,
  rejectIfNotMcpProcess,
} from "@/lib/mcp/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const blocked = rejectIfNotMcpProcess();
  if (blocked) return blocked;
  return mcpJson(protectedResourceMetadata(request));
}

export function OPTIONS() {
  return preflight();
}

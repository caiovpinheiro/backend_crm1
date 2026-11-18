import { can, loadAuthzContext } from "@/lib/authz";
import type { AppSession } from "@/lib/auth-helpers";
import type { McpViewer } from "@/services/mcp/connections";

/** `mcp:manage` (ADMIN via `*`). Super-admin não ganha bypass no MCP. */
export async function viewerOf(session: AppSession): Promise<McpViewer | null> {
  const orgId = session.user.organizationId;
  if (!orgId) return null;
  const ctx = await loadAuthzContext({
    userId: session.user.id,
    organizationId: orgId,
    isSuperAdmin: false,
  });
  return { id: session.user.id, organizationId: orgId, canManage: can(ctx, "mcp:manage") };
}

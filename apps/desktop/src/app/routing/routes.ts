import { MessagesSquare, Settings, type LucideIcon } from "lucide-react";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export type RouteId = "webchats" | "settings";

export interface RouteDef {
  id: RouteId;
  label: string;
  icon: LucideIcon;
  component: LazyExoticComponent<ComponentType>;
}

/**
 * The whole app: the chats (the questions beside the chat tabs, Custom chat among them) and
 * Settings, which the gear in the title bar opens and closes. Lazy-loaded so the first paint stays fast.
 */
export const ROUTES: RouteDef[] = [
  // Chat websites are native child webviews; Custom chat is drawn by ZHU (see features/webchat).
  { id: "webchats", label: "Chats", icon: MessagesSquare, component: lazy(() => import("@/features/webchat/WebChatScreen")) },
  { id: "settings", label: "Settings", icon: Settings, component: lazy(() => import("@/features/settings/SettingsScreen")) },
];

export const ROUTE_BY_ID: Record<RouteId, RouteDef> = Object.fromEntries(ROUTES.map((r) => [r.id, r])) as Record<RouteId, RouteDef>;

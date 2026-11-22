import { History, Home, MessagesSquare, Settings, type LucideIcon } from "lucide-react";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export type RouteId = "home" | "webchats" | "history" | "settings";

export interface RouteDef {
  id: RouteId;
  label: string;
  icon: LucideIcon;
  component: LazyExoticComponent<ComponentType>;
}

/** The whole app: four screens. Screens are lazy-loaded so the first paint stays fast. */
export const ROUTES: RouteDef[] = [
  { id: "home", label: "Home", icon: Home, component: lazy(() => import("@/features/home/HomeScreen")) },
  // AI chats shows provider websites in native child webviews (see features/webchat).
  { id: "webchats", label: "AI chats", icon: MessagesSquare, component: lazy(() => import("@/features/webchat/WebChatScreen")) },
  { id: "history", label: "History", icon: History, component: lazy(() => import("@/features/history/HistoryScreen")) },
  { id: "settings", label: "Settings", icon: Settings, component: lazy(() => import("@/features/settings/SettingsScreen")) },
];

export const ROUTE_BY_ID: Record<RouteId, RouteDef> = Object.fromEntries(ROUTES.map((r) => [r.id, r])) as Record<RouteId, RouteDef>;

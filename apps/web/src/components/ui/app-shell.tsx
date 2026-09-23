import {
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";
import { ScrollArea } from "./scroll-area";

export type FoundryViewScrollMode = "contained" | "page";
export type FoundryThemeMode = "light" | "dark";

export interface FoundryShellProps extends HTMLAttributes<HTMLElement> {
  theme?: FoundryThemeMode;
}

export function FoundryShell({
  className,
  theme = "light",
  ...props
}: FoundryShellProps) {
  return (
    <main
      className={cn("fdy-foundry-shell", className)}
      data-theme={theme}
      {...props}
    />
  );
}

export function FoundryMain({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return <section className={cn("fdy-main", className)} {...props} />;
}

export function NoticeStack({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("fdy-notice-stack", className)} {...props} />;
}

export interface NoticeLineProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function NoticeLine({ children, className, ...props }: NoticeLineProps) {
  return (
    <div
      className={cn("fdy-notice-line", className)}
      aria-live="polite"
      {...props}
    >
      <Zap size={13} />
      {children}
    </div>
  );
}

export interface FoundryViewProps extends HTMLAttributes<HTMLDivElement> {
  scrollMode: FoundryViewScrollMode;
}

export function FoundryView({
  className,
  scrollMode,
  ...props
}: FoundryViewProps) {
  return (
    <div
      className={cn("fdy-view", className)}
      data-foundry-scroll-reset="true"
      data-foundry-view="true"
      data-scroll-mode={scrollMode}
      {...props}
    />
  );
}

export interface SidebarNavBadge {
  children: ReactNode;
  tone?: "brass" | "neutral";
}

export interface SidebarNavLiveCount {
  children: ReactNode;
}

export interface SidebarNavItem<T extends string> {
  badge?: SidebarNavBadge;
  icon: LucideIcon;
  id: T;
  label: string;
  liveCount?: SidebarNavLiveCount;
}

export interface SidebarNavSection<T extends string> {
  items: Array<SidebarNavItem<T>>;
  label: string;
}

export interface FoundrySidebarProps<T extends string> {
  workspaceSelector?: ReactNode;
  activeItemId?: T;
  brandName?: string;
  collapsed?: boolean;
  navSections: Array<SidebarNavSection<T>>;
  onNavSelect: (id: T) => void;
  onThemeToggle?: () => void;
  onToggleCollapsed?: () => void;
  theme?: FoundryThemeMode;
  workspaceName: ReactNode;
}

export function FoundrySidebar<T extends string>({
  activeItemId,
  brandName = "Foundry",
  collapsed = false,
  navSections,
  onNavSelect,
  onThemeToggle,
  onToggleCollapsed,
  theme = "light",
  workspaceName,
  workspaceSelector,
}: FoundrySidebarProps<T>) {
  return (
    <aside
      className="fdy-sidebar"
      data-collapsed={collapsed ? "true" : "false"}
    >
      <SidebarBrand
        collapsed={collapsed}
        name={brandName}
        workspaceName={workspaceName}
        onThemeToggle={onThemeToggle}
        onToggleCollapsed={onToggleCollapsed}
        theme={theme}
      />
      {workspaceSelector ? (
        <div className="fdy-sidebar-workspace-slot">{workspaceSelector}</div>
      ) : null}
      <SidebarNav
        activeItemId={activeItemId}
        onSelect={onNavSelect}
        sections={navSections}
      />
    </aside>
  );
}

export interface SidebarBrandProps {
  collapsed?: boolean;
  name: ReactNode;
  workspaceName: ReactNode;
  onThemeToggle?: () => void;
  onToggleCollapsed?: () => void;
  theme?: FoundryThemeMode;
}

export function SidebarBrand({
  collapsed = false,
  name,
  workspaceName,
  onThemeToggle,
  onToggleCollapsed,
  theme = "light",
}: SidebarBrandProps) {
  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const ThemeIcon = theme === "dark" ? Sun : Moon;
  const themeLabel =
    theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

  return (
    <div className="fdy-sidebar-brand">
      <span className="fdy-sidebar-brand-icon">
        <img src={`${import.meta.env.BASE_URL}foundry-icon.png`} alt="" />
      </span>
      <span className="fdy-sidebar-brand-copy">
        <strong>{name}</strong>
        <small>{workspaceName}</small>
      </span>
      <span className="fdy-sidebar-brand-actions">
        <Button
          aria-label={themeLabel}
          aria-pressed={theme === "dark"}
          className="fdy-sidebar-theme-button"
          onClick={onThemeToggle}
          size="icon"
          title={themeLabel}
          variant="ghost"
        >
          <ThemeIcon size={15} />
        </Button>
        <Button
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="fdy-sidebar-collapse-button"
          onClick={onToggleCollapsed}
          size="icon"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          variant="ghost"
        >
          <CollapseIcon size={15} />
        </Button>
      </span>
    </div>
  );
}

export interface SidebarNavProps<T extends string> {
  activeItemId?: T;
  onSelect: (id: T) => void;
  sections: Array<SidebarNavSection<T>>;
}

export function SidebarNav<T extends string>({
  activeItemId,
  onSelect,
  sections,
}: SidebarNavProps<T>) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<T, HTMLButtonElement>());
  const [scrollEdges, setScrollEdges] = useState({ end: false, start: false });

  const updateScrollEdges = useCallback(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const maxScrollLeft = Math.max(
      0,
      viewport.scrollWidth - viewport.clientWidth,
    );
    const nextEdges = {
      end: viewport.scrollLeft < maxScrollLeft - 2,
      start: viewport.scrollLeft > 2,
    };

    setScrollEdges((currentEdges) =>
      currentEdges.end === nextEdges.end &&
      currentEdges.start === nextEdges.start
        ? currentEdges
        : nextEdges,
    );
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const activeItem = activeItemId
      ? itemRefs.current.get(activeItemId)
      : undefined;

    if (
      !viewport ||
      !activeItem ||
      viewport.scrollWidth <= viewport.clientWidth
    ) {
      return;
    }

    activeItem.scrollIntoView({
      block: "nearest",
      inline: "center",
    });
    window.requestAnimationFrame(updateScrollEdges);
  }, [activeItemId, updateScrollEdges]);

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    viewport.addEventListener("scroll", updateScrollEdges, { passive: true });
    window.addEventListener("resize", updateScrollEdges);
    updateScrollEdges();

    return () => {
      viewport.removeEventListener("scroll", updateScrollEdges);
      window.removeEventListener("resize", updateScrollEdges);
    };
  }, [updateScrollEdges]);

  return (
    <ScrollArea
      className="fdy-sidebar-nav-scroll"
      data-scroll-end={scrollEdges.end ? "true" : "false"}
      data-scroll-start={scrollEdges.start ? "true" : "false"}
      viewportRef={viewportRef}
    >
      <nav className="fdy-sidebar-nav">
        {sections.map((section) => (
          <div className="fdy-sidebar-nav-section" key={section.label}>
            <span>{section.label}</span>
            {section.items.map((item) => (
              <SidebarNavButton
                active={item.id === activeItemId}
                item={item}
                key={item.id}
                refCallback={(node) => {
                  if (node) {
                    itemRefs.current.set(item.id, node);
                  } else {
                    itemRefs.current.delete(item.id);
                  }
                }}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}
      </nav>
    </ScrollArea>
  );
}

interface SidebarNavButtonProps<T extends string> {
  active: boolean;
  item: SidebarNavItem<T>;
  onSelect: (id: T) => void;
  refCallback?: (node: HTMLButtonElement | null) => void;
}

function SidebarNavButton<T extends string>({
  active,
  item,
  onSelect,
  refCallback,
}: SidebarNavButtonProps<T>) {
  const Icon = item.icon;

  return (
    <Button
      aria-label={`Open ${item.label}`}
      className="fdy-sidebar-nav-link"
      data-nav-id={item.id}
      data-foundry-sidebar-nav-link="true"
      data-state={active ? "active" : "idle"}
      onClick={() => onSelect(item.id)}
      ref={refCallback}
      variant="nav"
    >
      <span className="fdy-sidebar-nav-icon" aria-hidden="true">
        <Icon />
      </span>
      <span className="fdy-sidebar-nav-label">{item.label}</span>
      {item.badge ? (
        <b data-tone={item.badge.tone ?? "brass"}>{item.badge.children}</b>
      ) : null}
      {item.liveCount ? (
        <i>
          <span />
          {item.liveCount.children}
        </i>
      ) : null}
    </Button>
  );
}

export interface TopbarProps {
  action: ReactNode;
  actionMobileVisible?: boolean;
  path: ReactNode;
  providerChips: ReactNode;
  title: ReactNode;
}

export function Topbar({
  action,
  actionMobileVisible = true,
  path,
  providerChips,
  title,
}: TopbarProps) {
  return (
    <header className="fdy-topbar">
      <div className="fdy-topbar-title">
        <strong>{title}</strong>
        <code>{path}</code>
      </div>
      <div className="fdy-topbar-provider-chips">{providerChips}</div>
      <span className="fdy-topbar-divider" />
      <span
        className="fdy-topbar-action"
        data-mobile-visible={actionMobileVisible ? "true" : "false"}
      >
        {action}
      </span>
    </header>
  );
}

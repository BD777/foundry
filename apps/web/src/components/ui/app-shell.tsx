import {
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "../../lib/cn";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Tooltip } from "./tooltip";
import { FoundryThemeContext } from "./theme-context";

export type FoundryViewScrollMode = "contained" | "page";
export type FoundryThemeMode = "light" | "dark";

export interface FoundryShellProps extends HTMLAttributes<HTMLElement> {
  theme?: FoundryThemeMode;
  /**
   * How the current view scrolls. A contained view (a chat) fills the
   * viewport and scrolls its own parts, so on narrow screens the shell keeps
   * a fixed height instead of letting the page grow.
   */
  scrollMode?: FoundryViewScrollMode;
}

export function FoundryShell({
  className,
  theme = "light",
  scrollMode = "page",
  ...props
}: FoundryShellProps) {
  return (
    <FoundryThemeContext.Provider value={theme}>
      <main
        className={cn("fdy-foundry-shell", className)}
        data-scroll-mode={scrollMode}
        data-theme={theme}
        {...props}
      />
    </FoundryThemeContext.Provider>
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
  /** What the notice offers to do, after its text (a Button). */
  action?: ReactNode;
}

export function NoticeLine({
  action,
  children,
  className,
  ...props
}: NoticeLineProps) {
  return (
    <div
      className={cn("fdy-notice-line", className)}
      aria-live="polite"
      {...props}
    >
      <Zap size={13} />
      {children}
      {action ? <span className="fdy-notice-line-action">{action}</span> : null}
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
  /** Stable identity, independent of the displayed language. */
  id: string;
  /** Context shown in navigation tooltips, including when collapsed. */
  scopeLabel?: string;
  /** A visible boundary before a new navigation scope, also when collapsed. */
  dividerBefore?: boolean;
  /** Controls for this section alone, before its links. */
  header?: ReactNode;
  items: Array<SidebarNavItem<T>>;
  label: string;
}

export interface FoundrySidebarProps<T extends string> {
  activeItemId?: T;
  brandName?: string;
  collapsed?: boolean;
  /** A control beside the theme button, such as the interface language. */
  languageControl?: ReactNode;
  navSections: Array<SidebarNavSection<T>>;
  onNavSelect: (id: T) => void;
  onThemeToggle?: () => void;
  onToggleCollapsed?: () => void;
  theme?: FoundryThemeMode;
}

export function FoundrySidebar<T extends string>({
  activeItemId,
  brandName = "Foundry",
  collapsed = false,
  languageControl,
  navSections,
  onNavSelect,
  onThemeToggle,
  onToggleCollapsed,
  theme = "light",
}: FoundrySidebarProps<T>) {
  return (
    <aside
      className="fdy-sidebar"
      data-collapsed={collapsed ? "true" : "false"}
    >
      <SidebarBrand
        collapsed={collapsed}
        name={brandName}
        languageControl={languageControl}
        onThemeToggle={onThemeToggle}
        onToggleCollapsed={onToggleCollapsed}
        theme={theme}
      />
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
  languageControl?: ReactNode;
  onThemeToggle?: () => void;
  onToggleCollapsed?: () => void;
  theme?: FoundryThemeMode;
}

export function SidebarBrand({
  collapsed = false,
  name,
  languageControl,
  onThemeToggle,
  onToggleCollapsed,
  theme = "light",
}: SidebarBrandProps) {
  const { t } = useTranslation("shell");
  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const ThemeIcon = theme === "dark" ? Sun : Moon;
  const themeLabel =
    theme === "dark" ? t("sidebar.lightMode") : t("sidebar.darkMode");
  const collapseLabel = collapsed ? t("sidebar.expand") : t("sidebar.collapse");

  return (
    <div className="fdy-sidebar-brand">
      <span className="fdy-sidebar-brand-icon">
        <img src={`${import.meta.env.BASE_URL}foundry-icon.png`} alt="" />
      </span>
      <span className="fdy-sidebar-brand-copy">
        <strong>{name}</strong>
      </span>
      <span
        className="fdy-sidebar-brand-actions"
        role="group"
        aria-label={t("sidebar.interfaceControls")}
      >
        {languageControl}
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
          aria-label={collapseLabel}
          className="fdy-sidebar-collapse-button"
          onClick={onToggleCollapsed}
          size="icon"
          title={collapseLabel}
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
  const itemRefs = useRef(new Map<T, HTMLButtonElement>());
  useEffect(() => {
    const revealActive = () => {
      const activeItem = activeItemId
        ? itemRefs.current.get(activeItemId)
        : null;
      activeItem?.scrollIntoView({ block: "nearest", inline: "center" });
    };
    revealActive();
    // Crossing the layout breakpoint reveals the current entry. A phone's
    // keyboard changes viewport height too; it must not pull the page back
    // to navigation while the person is editing its contents.
    const layout = window.matchMedia("(max-width: 860px)");
    layout.addEventListener("change", revealActive);
    return () => layout.removeEventListener("change", revealActive);
  }, [activeItemId]);

  return (
    <div className="fdy-sidebar-nav-scroll">
      <nav
        className="fdy-sidebar-nav"
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          if (
            ![
              "ArrowDown",
              "ArrowUp",
              "ArrowRight",
              "ArrowLeft",
              "Home",
              "End",
            ].includes(event.key)
          )
            return;
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          );
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index +
                    (event.key === "ArrowDown" || event.key === "ArrowRight"
                      ? 1
                      : -1) +
                    buttons.length) %
                  buttons.length;
          event.preventDefault();
          buttons[next]?.focus();
        }}
      >
        {sections.map((section) => (
          <Fragment key={section.id}>
            {section.dividerBefore ? (
              <div className="fdy-sidebar-scope-divider" aria-hidden="true" />
            ) : null}
            <section
              className="fdy-sidebar-nav-section"
              data-section-id={section.id}
              aria-label={section.label}
            >
              <span className="fdy-sidebar-nav-heading">{section.label}</span>
              <div className="fdy-sidebar-nav-items">
                {section.header ? (
                  <div className="fdy-sidebar-section-header">
                    {section.header}
                  </div>
                ) : null}
                {section.items.map((item) => (
                  <SidebarNavButton
                    active={item.id === activeItemId}
                    item={item}
                    scopeLabel={section.scopeLabel ?? section.label}
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
            </section>
          </Fragment>
        ))}
      </nav>
    </div>
  );
}

interface SidebarNavButtonProps<T extends string> {
  active: boolean;
  item: SidebarNavItem<T>;
  scopeLabel: string;
  onSelect: (id: T) => void;
  refCallback?: (node: HTMLButtonElement | null) => void;
}

function SidebarNavButton<T extends string>({
  active,
  item,
  scopeLabel,
  onSelect,
  refCallback,
}: SidebarNavButtonProps<T>) {
  const { t } = useTranslation("shell");
  const Icon = item.icon;

  return (
    <Tooltip content={`${scopeLabel} · ${item.label}`}>
      <Button
        aria-current={active ? "page" : undefined}
        aria-label={t("sidebar.open", { label: item.label })}
        title={`${scopeLabel} · ${item.label}`}
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
    </Tooltip>
  );
}
